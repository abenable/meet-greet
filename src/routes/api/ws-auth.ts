import { createFileRoute } from '@tanstack/react-router'
import { getRequest } from '@tanstack/react-start/server'
import { canSubscribeToEvent, resolveChatPeer, resolveWebSocketSession } from '#/server/ws-auth'

/**
 * Authorization endpoint for the WebSocket server.
 *
 * The Bun server in server.prod.ts cannot import `src/` directly: those modules
 * use the `#/*` alias, and Node's subpath-imports spec rejects keys starting
 * with `#/`, so Bun >= 1.4.2 refuses to resolve them outside the Vite build.
 * Routing through the bundled app keeps one implementation of the rules
 * (src/server/ws-auth.ts) and lets the build resolve the aliases.
 *
 * Answers only about the caller's own session, using the caller's own cookies:
 * who am I, and may I subscribe to this event's topic. Both are things the
 * caller could already determine about themselves.
 */
async function handleWsAuth() {
  const request = getRequest()

  const session = await resolveWebSocketSession(request)
  if (!session) {
    return Response.json({ authenticated: false }, { status: 401 })
  }

  const params = new URL(request.url).searchParams
  const eventId = params.get('eventId')
  const chatId = params.get('chatId')

  const [canSubscribe, peerId] = await Promise.all([
    eventId ? canSubscribeToEvent(session.userId, eventId) : Promise.resolve(undefined),
    chatId ? resolveChatPeer(session.userId, chatId) : Promise.resolve(undefined),
  ])

  return Response.json({
    authenticated: true,
    userId: session.userId,
    ...(eventId ? { canSubscribe } : {}),
    ...(chatId ? { peerId } : {}),
  })
}

export const Route = createFileRoute('/api/ws-auth')({
  server: {
    handlers: {
      GET: handleWsAuth,
    },
  },
})
