import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useWebSocketContext } from '#/integrations/websocket/WebSocketProvider'

export interface WSMessage {
  type:
    | 'chat_message'
    | 'match_created'
    | 'typing'
    | 'read_receipt'
    | 'online_status'
    | 'event_post'
    | 'error'
  payload: any
  timestamp: number
}

interface UseWebSocketConnectionOptions {
  onMessage?: (message: WSMessage) => void
  onConnect?: () => void
  onDisconnect?: () => void
  autoReconnect?: boolean
}

/**
 * Owns the single WebSocket for the app. Mounted once by WebSocketProvider —
 * components read it through useWebSocketContext() rather than calling this,
 * so a page doesn't end up holding a second socket alongside the provider's.
 */
export function useWebSocketConnection(options: UseWebSocketConnectionOptions = {}) {
  const { onMessage, onConnect, onDisconnect, autoReconnect = true } = options
  const [connected, setConnected] = useState(false)
  const [lastMessage, setLastMessage] = useState<WSMessage | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const reconnectAttemptsRef = useRef(0)
  // Set during teardown so the socket's own close handler doesn't schedule a
  // reconnect after cleanup has already run.
  const closingRef = useRef(false)
  const queryClient = useQueryClient()

  const subscribersRef = useRef(new Set<(message: WSMessage) => void>())

  const onMessageRef = useRef(onMessage)
  const onConnectRef = useRef(onConnect)
  const onDisconnectRef = useRef(onDisconnect)

  onMessageRef.current = onMessage
  onConnectRef.current = onConnect
  onDisconnectRef.current = onDisconnect

  const handleMessage = useCallback(
    (message: WSMessage) => {
      switch (message.type) {
        case 'chat_message':
          queryClient.invalidateQueries({ queryKey: ['chat', message.payload.chatId] })
          queryClient.invalidateQueries({ queryKey: ['conversations'] })
          queryClient.invalidateQueries({ queryKey: ['unread-notifications'] })
          break

        case 'match_created':
          queryClient.invalidateQueries({ queryKey: ['matches'] })
          queryClient.invalidateQueries({ queryKey: ['conversations'] })
          break

        case 'read_receipt':
          queryClient.invalidateQueries({ queryKey: ['chat', message.payload.chatId] })
          break

        case 'event_post':
          queryClient.invalidateQueries({ queryKey: ['event-posts', message.payload.eventId] })
          break

        case 'typing':
        case 'online_status':
          break

        case 'error':
          console.error('WebSocket error:', message.payload)
          break
      }
    },
    [queryClient],
  )

  const connect = useCallback(() => {
    if (typeof window === 'undefined') return
    if (closingRef.current) return
    if (
      wsRef.current?.readyState === WebSocket.OPEN ||
      wsRef.current?.readyState === WebSocket.CONNECTING
    ) {
      return
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`)
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      reconnectAttemptsRef.current = 0
      onConnectRef.current?.()
    }

    ws.onmessage = (event) => {
      try {
        const message: WSMessage = JSON.parse(event.data)
        setLastMessage(message)
        onMessageRef.current?.(message)
        for (const subscriber of subscribersRef.current) subscriber(message)
        handleMessage(message)
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error)
      }
    }

    ws.onclose = () => {
      setConnected(false)
      if (wsRef.current === ws) wsRef.current = null
      onDisconnectRef.current?.()

      // The previous version cleared the reconnect timer and *then* closed the
      // socket, so this handler ran after cleanup and scheduled a fresh
      // reconnect — every unmount leaked a socket that kept reconnecting.
      if (!autoReconnect || closingRef.current) return

      const delay = Math.min(1000 * 2 ** reconnectAttemptsRef.current, 30000)
      reconnectAttemptsRef.current++
      reconnectTimeoutRef.current = setTimeout(connect, delay)
    }

    ws.onerror = () => {
      // onclose always follows; reconnect is handled there.
    }
  }, [autoReconnect, handleMessage])

  const disconnect = useCallback(() => {
    closingRef.current = true
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = undefined
    }
    wsRef.current?.close()
    wsRef.current = null
    setConnected(false)
  }, [])

  const send = useCallback((message: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message))
    }
  }, [])

  const subscribeToEvent = useCallback(
    (eventId: string) => send({ type: 'subscribe_event', eventId }),
    [send],
  )
  const unsubscribeFromEvent = useCallback(
    (eventId: string) => send({ type: 'unsubscribe_event', eventId }),
    [send],
  )
  const sendTyping = useCallback(
    (chatId: string, isTyping: boolean) => send({ type: 'typing', chatId, isTyping }),
    [send],
  )

  /** Register a listener without opening another socket. */
  const addMessageListener = useCallback((listener: (message: WSMessage) => void) => {
    subscribersRef.current.add(listener)
    return () => {
      subscribersRef.current.delete(listener)
    }
  }, [])

  const reconnect = useCallback(() => {
    closingRef.current = false
    reconnectAttemptsRef.current = 0
    connect()
  }, [connect])

  useEffect(() => {
    closingRef.current = false
    connect()
    return () => {
      disconnect()
    }
  }, [connect, disconnect])

  return {
    connected,
    lastMessage,
    send,
    subscribeToEvent,
    unsubscribeFromEvent,
    sendTyping,
    addMessageListener,
    reconnect,
    disconnect,
  }
}

/**
 * Chat-scoped view of the shared connection: typing indicators for one chat,
 * plus everything the provider exposes.
 */
export function useChatWebSocket(chatId: string) {
  const ws = useWebSocketContext()
  const [typingUsers, setTypingUsers] = useState<string[]>([])
  const typingTimeoutRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // Depend on addMessageListener, not the whole `ws` object. The connection
  // hook returns a fresh object every render and setLastMessage fires on every
  // frame, so depending on `ws` re-ran this effect for each incoming message —
  // the cleanup blanked typingUsers, and the indicator never stayed visible.
  const { addMessageListener } = ws

  useEffect(() => {
    const timeouts = typingTimeoutRef.current

    const unsubscribe = addMessageListener((message) => {
      if (message.type !== 'typing' || message.payload?.chatId !== chatId) return

      const { userId, isTyping } = message.payload
      if (typeof userId !== 'string') return

      const clear = () => {
        const existing = timeouts.get(userId)
        if (existing) {
          clearTimeout(existing)
          timeouts.delete(userId)
        }
      }

      if (isTyping) {
        setTypingUsers((prev) => (prev.includes(userId) ? prev : [...prev, userId]))
        clear()
        timeouts.set(
          userId,
          setTimeout(() => {
            setTypingUsers((prev) => prev.filter((id) => id !== userId))
            timeouts.delete(userId)
          }, 3000),
        )
      } else {
        setTypingUsers((prev) => prev.filter((id) => id !== userId))
        clear()
      }
    })

    return () => {
      unsubscribe()
      for (const timeout of timeouts.values()) clearTimeout(timeout)
      timeouts.clear()
      setTypingUsers([])
    }
  }, [chatId, addMessageListener])

  return { ...ws, typingUsers }
}
