import { auth } from '#/lib/auth'
import { prisma } from '#/db'

export interface WsSession {
  userId: string
}

/**
 * Resolve the signed-in user for a WebSocket upgrade.
 *
 * The upgrade handler previously called `server.upgrade(request)` with no
 * `data`, so `ws.data?.userId` was always undefined, nothing ever subscribed to
 * `user:<id>`, and every broadcastToUser() published into an empty topic. It
 * also accepted the upgrade from anyone, authenticated or not.
 *
 * Identity comes from better-auth's own `auth.api.getSession({ headers })`
 * rather than from parsing the cookie here. The session cookie is HMAC-signed
 * (better-auth reads it with getSignedCookie), so hand-rolling the parse would
 * skip signature verification and drift from whatever cookie name, prefix or
 * cookie-cache strategy the auth config uses.
 *
 * It is deliberately NOT taken from a query parameter or from the first client
 * message: either would let a caller name someone else's user id and receive
 * their messages.
 */
export async function resolveWebSocketSession(request: Request): Promise<WsSession | null> {
  let result: Awaited<ReturnType<typeof auth.api.getSession>>
  try {
    result = await auth.api.getSession({ headers: request.headers })
  } catch {
    return null
  }

  const userId = result?.user?.id
  if (!userId) return null

  // Same bar as requireSession(): live session, enabled account, verified email.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { disabledAt: true, emailVerified: true },
  })
  if (!user || user.disabledAt || !user.emailVerified) return null

  return { userId }
}

/**
 * Given a chatId, return the other participant — but only if this user is
 * actually in that conversation. Used to relay typing indicators without
 * letting a client address arbitrary users.
 */
export async function resolveChatPeer(userId: string, chatId: string): Promise<string | null> {
  if (chatId.startsWith('match_')) {
    const matchId = chatId.slice('match_'.length)
    if (!matchId) return null
    const match = await prisma.eventMatch.findFirst({
      where: { id: matchId, OR: [{ user1Id: userId }, { user2Id: userId }] },
      select: { user1Id: true, user2Id: true },
    })
    if (!match) return null
    return match.user1Id === userId ? match.user2Id : match.user1Id
  }

  if (chatId.startsWith('org_')) {
    const rest = chatId.slice('org_'.length)
    const separator = rest.indexOf('_')
    if (separator <= 0) return null
    const eventId = rest.slice(0, separator)
    const peerId = rest.slice(separator + 1)
    if (!eventId || !peerId) return null

    const [me, peer] = await Promise.all([
      prisma.eventAttendee.findFirst({
        where: { eventId, userId, leftAt: null },
        select: { id: true },
      }),
      prisma.eventAttendee.findFirst({
        where: { eventId, userId: peerId, leftAt: null },
        select: { id: true },
      }),
    ])
    return me && peer ? peerId : null
  }

  return null
}

/** Is this user an active attendee (or the organizer) of the event? */
export async function canSubscribeToEvent(userId: string, eventId: string): Promise<boolean> {
  const [attendee, event] = await Promise.all([
    prisma.eventAttendee.findFirst({
      where: { eventId, userId, leftAt: null },
      select: { id: true },
    }),
    prisma.event.findUnique({
      where: { id: eventId },
      select: { createdById: true },
    }),
  ])

  return !!attendee || event?.createdById === userId
}
