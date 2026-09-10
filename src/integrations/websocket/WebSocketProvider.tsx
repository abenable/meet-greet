import { createContext, useContext, type ReactNode } from 'react'
import { useWebSocketConnection, type WSMessage } from '#/hooks/useWebSocket'

interface WebSocketContextValue {
  connected: boolean
  lastMessage: WSMessage | null
  send: (message: unknown) => void
  subscribeToEvent: (eventId: string) => void
  unsubscribeFromEvent: (eventId: string) => void
  sendTyping: (chatId: string, isTyping: boolean) => void
  addMessageListener: (listener: (message: WSMessage) => void) => () => void
  reconnect: () => void
  disconnect: () => void
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null)

/**
 * The app's single WebSocket lives here. Components consume it via
 * useWebSocketContext() or useChatWebSocket(); calling the connection hook
 * directly would open a second socket per tab.
 */
export function WebSocketProvider({ children }: { children: ReactNode }) {
  const ws = useWebSocketConnection({ autoReconnect: true })

  return <WebSocketContext.Provider value={ws}>{children}</WebSocketContext.Provider>
}

export function useWebSocketContext() {
  const context = useContext(WebSocketContext)
  if (!context) {
    throw new Error('useWebSocketContext must be used within WebSocketProvider')
  }
  return context
}
