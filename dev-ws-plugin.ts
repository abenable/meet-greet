import type { Plugin } from 'vite'
import type { WebSocket } from 'ws'

/**
 * Dev-mode stand-in for the Bun WebSocket server in server.prod.ts.
 *
 * It mirrors production's authorization rules on purpose: the upgrade requires
 * a valid session cookie, sockets are auto-subscribed to their own `user:<id>`
 * topic, and event subscriptions are checked against attendance. Previously
 * this accepted anyone and let any client subscribe to any event topic, so a
 * bug that only reproduced in dev — or a hole that only existed in prod —
 * could hide behind the difference.
 */
export function devWebSocketPlugin(): Plugin {
  return {
    name: 'dev-websocket',
    configureServer(server) {
      if (!server.httpServer) return

      Promise.all([
        import('ws'),
        server.ssrLoadModule('/src/server/ws-auth.ts') as Promise<
          typeof import('./src/server/ws-auth')
        >,
      ]).then(([{ WebSocketServer }, wsAuth]) => {
        const wss = new WebSocketServer({ noServer: true })
        const clients = new Map<WebSocket, Set<string>>()

        const publish = (topic: string, message: string) => {
          for (const [ws, topics] of clients) {
            if (ws.readyState === 1 /* OPEN */ && topics.has(topic)) {
              ws.send(message)
            }
          }
        }

        wss.on('connection', (ws: WebSocket, _req: unknown, userId: string) => {
          const topics = new Set<string>([`user:${userId}`])
          clients.set(ws, topics)

          ws.on('message', async (raw: Buffer | ArrayBuffer | Buffer[]) => {
            try {
              const data =
                typeof raw === 'string' ? raw : Buffer.from(raw as Buffer).toString()
              if (data.length > 8192) throw new Error('Message too large')
              const msg = JSON.parse(data)

              switch (msg.type) {
                case 'subscribe_event':
                  if (typeof msg.eventId === 'string' && msg.eventId) {
                    if (await wsAuth.canSubscribeToEvent(userId, msg.eventId)) {
                      topics.add(`event:${msg.eventId}`)
                    } else {
                      ws.send(
                        JSON.stringify({
                          type: 'error',
                          payload: { message: 'Not authorized for this event' },
                          timestamp: Date.now(),
                        })
                      )
                    }
                  }
                  break
                case 'unsubscribe_event':
                  if (typeof msg.eventId === 'string' && msg.eventId) {
                    topics.delete(`event:${msg.eventId}`)
                  }
                  break
                case 'ping':
                  ws.send(
                    JSON.stringify({
                      type: 'online_status',
                      payload: { pong: true },
                      timestamp: Date.now(),
                    })
                  )
                  break
              }
            } catch {
              ws.send(
                JSON.stringify({
                  type: 'error',
                  payload: { message: 'Invalid message format' },
                  timestamp: Date.now(),
                })
              )
            }
          })

          ws.on('close', () => clients.delete(ws))
        })

        server.httpServer!.on('upgrade', async (request, socket, head) => {
          if (request.url !== '/ws') return

          const headers = new Headers()
          for (const [key, value] of Object.entries(request.headers)) {
            if (typeof value === 'string') headers.set(key, value)
          }

          const session = await wsAuth.resolveWebSocketSession(
            new Request('http://localhost/ws', { headers })
          )

          if (!session) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
            socket.destroy()
            return
          }

          wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request, session.userId)
          })
        })

        ;(globalThis as any).__devWSS__ = { publish }
      })
    },
  }
}
