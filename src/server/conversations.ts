import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { prisma } from '#/db'
import { requireSession } from '#/server/auth'
import { r2Client, R2_BUCKET_NAME, R2_PUBLIC_URL } from '#/lib/r2'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { randomUUID } from 'node:crypto'
import { createNotification } from './notifications.server'
import { broadcastChatMessage } from './websocket-broadcast'
import { sanitizeText } from '#/lib/sanitize'
import { rateLimit } from '#/lib/rate-limit'
import { getUserScopedIdentifier } from '#/lib/rate-limit.server'

/** Most recent threads returned by the chat list. */
const CONVERSATION_LIMIT = 200
/** Messages returned per page of a thread. */
const MESSAGE_PAGE_SIZE = 50
/** Voice clips cap out at 5MB decoded. */
const MAX_AUDIO_BYTES = 5 * 1024 * 1024
// base64 inflates by ~4/3; add slack for the data-URL prefix.
const MAX_AUDIO_BASE64_LENGTH = Math.ceil(MAX_AUDIO_BYTES * 1.4)

const messageRateLimit = rateLimit({ windowMs: 60 * 1000, maxRequests: 60 })
const voiceUploadRateLimit = rateLimit({ windowMs: 60 * 1000, maxRequests: 10 })

export const getConversations = createServerFn({ method: 'GET' })
  .handler(async () => {
    const session = await requireSession()
    const myId = session.user.id

    // 1. Match conversations
    const matches = await prisma.eventMatch.findMany({
      where: {
        OR: [{ user1Id: myId }, { user2Id: myId }],
      },
      include: {
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: CONVERSATION_LIMIT,
    })

    const matchPeerIds = matches.map((m) =>
      m.user1Id === myId ? m.user2Id : m.user1Id
    )

    // Filter out blocked peers
    const allPotentialPeerIds = [...new Set(matchPeerIds)]
    const blockedRelations = await prisma.userBlock.findMany({
      where: {
        OR: [
          { blockerId: myId, blockedId: { in: allPotentialPeerIds } },
          { blockerId: { in: allPotentialPeerIds }, blockedId: myId },
        ],
      },
      select: { blockerId: true, blockedId: true },
    })
    const blockedPeerIds = new Set<string>()
    for (const b of blockedRelations) {
      blockedPeerIds.add(b.blockerId === myId ? b.blockedId : b.blockerId)
    }

    const filteredMatches = matches.filter((m) => {
      const peerId = m.user1Id === myId ? m.user2Id : m.user1Id
      return !blockedPeerIds.has(peerId)
    })
    const filteredMatchPeerIds = filteredMatches.map((m) =>
      m.user1Id === myId ? m.user2Id : m.user1Id
    )

    // 2. Organizer conversations.
    //
    // This used to load every organizer message the user had ever sent or
    // received and group them in memory, which grows without bound. Postgres
    // does the grouping now: one row per (eventId, peer) with the latest
    // message id and the unread count, then a single fetch of those messages.
    const organizerSummaries = await prisma.$queryRaw<
      Array<{ eventId: string; peerId: string; lastMessageId: string; unreadCount: bigint }>
    >`
      SELECT
        "eventId",
        CASE WHEN "senderId" = ${myId} THEN "receiverId" ELSE "senderId" END AS "peerId",
        (ARRAY_AGG("id" ORDER BY "createdAt" DESC, "id" DESC))[1] AS "lastMessageId",
        COUNT(*) FILTER (WHERE "receiverId" = ${myId} AND "readAt" IS NULL) AS "unreadCount"
      FROM "EventOrganizerMessage"
      WHERE "senderId" = ${myId} OR "receiverId" = ${myId}
      GROUP BY "eventId", "peerId"
      ORDER BY MAX("createdAt") DESC
      LIMIT ${CONVERSATION_LIMIT}
    `

    const lastMessages = await prisma.eventOrganizerMessage.findMany({
      where: { id: { in: organizerSummaries.map((s) => s.lastMessageId) } },
    })
    const lastMessageById = new Map(lastMessages.map((m) => [m.id, m]))

    const organizerConvoMap = new Map<string, {
      eventId: string
      peerId: string
      lastMessage: (typeof lastMessages)[number]
      unreadCount: number
    }>()

    for (const summary of organizerSummaries) {
      if (blockedPeerIds.has(summary.peerId)) continue
      const lastMessage = lastMessageById.get(summary.lastMessageId)
      if (!lastMessage) continue
      organizerConvoMap.set(`${summary.eventId}:${summary.peerId}`, {
        eventId: summary.eventId,
        peerId: summary.peerId,
        lastMessage,
        unreadCount: Number(summary.unreadCount),
      })
    }

    const organizerPeerIds = [...organizerConvoMap.values()].map((c) => c.peerId)
    const eventIds = [...new Set([...organizerConvoMap.values()].map((c) => c.eventId))]

    const events = await prisma.event.findMany({
      where: { id: { in: eventIds } },
      select: { id: true, name: true },
    })

    // 3. Fetch all peer profiles and users for fallback photos/names
    const allPeerIds = [...new Set([...filteredMatchPeerIds, ...organizerPeerIds])]
    const [profiles, users] = await Promise.all([
      prisma.profile.findMany({ where: { userId: { in: allPeerIds } } }),
      prisma.user.findMany({
        where: { id: { in: allPeerIds } },
        select: { id: true, name: true, image: true, disabledAt: true },
      }),
    ])

    const userById = new Map(users.map((u) => [u.id, u]))
    const profileByUserId = new Map(profiles.map((p) => [p.userId, p]))

    const activePeerIds = new Set(
      allPeerIds.filter((id) => !userById.get(id)?.disabledAt)
    )

    const getPeerPhoto = (peerId: string) => {
      const profile = profileByUserId.get(peerId)
      const user = userById.get(peerId)
      if (profile?.photos && profile.photos.length > 0) return profile.photos[0]
      return user?.image
    }

    const getPeerName = (peerId: string) => {
      const profile = profileByUserId.get(peerId)
      const user = userById.get(peerId)
      return profile?.name || user?.name || 'Unknown'
    }

    const getPeerVerifiedAt = (peerId: string) => {
      const profile = profileByUserId.get(peerId)
      return profile?.verifiedAt ?? null
    }

    // Unread counts per match (messages from the peer I haven't read yet)
    const unreadGroups = filteredMatches.length > 0
      ? await prisma.eventMessage.groupBy({
          by: ['matchId'],
          where: {
            matchId: { in: filteredMatches.map((m) => m.id) },
            senderId: { not: myId },
            readAt: null,
          },
          _count: { id: true },
        })
      : []
    const unreadCountByMatchId = new Map(unreadGroups.map((g) => [g.matchId, g._count.id]))

    // Build match conversation list
    const matchConversations = filteredMatches
      .filter((match) => {
        const peerId = match.user1Id === myId ? match.user2Id : match.user1Id
        return activePeerIds.has(peerId)
      })
      .map((match) => {
        const peerId = match.user1Id === myId ? match.user2Id : match.user1Id
        return {
          id: `${match.id}`,
          chatId: `match_${match.id}`,
          type: 'match' as const,
          matchId: match.id,
          eventId: match.eventId,
          peerId,
          peerName: getPeerName(peerId),
          peerPhoto: getPeerPhoto(peerId),
          peerVerifiedAt: getPeerVerifiedAt(peerId),
          messagesUnlockedAt: match.messagesUnlockedAt,
          lastMessage: match.messages[0]?.content ?? 'New match!',
          lastMessageAt: match.messages[0]?.createdAt ?? match.createdAt,
          unreadCount: unreadCountByMatchId.get(match.id) ?? 0,
        }
      })

    // Build organizer conversation list
    const organizerConversations = [...organizerConvoMap.values()]
      .filter((convo) => activePeerIds.has(convo.peerId))
      .map((convo) => {
        const event = events.find((e) => e.id === convo.eventId)
        return {
          id: `${convo.eventId}:${convo.peerId}`,
          chatId: `org_${convo.eventId}_${convo.peerId}`,
        type: 'organizer' as const,
        eventId: convo.eventId,
        eventName: event?.name ?? 'Event',
        peerId: convo.peerId,
        peerName: getPeerName(convo.peerId),
        peerPhoto: getPeerPhoto(convo.peerId),
        peerVerifiedAt: getPeerVerifiedAt(convo.peerId),
        lastMessage: convo.lastMessage.content,
        lastMessageAt: convo.lastMessage.createdAt,
        unreadCount: convo.unreadCount,
      }
    })

    // Combine and sort by most recent message
    const all = [...matchConversations, ...organizerConversations]
    all.sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime())

    return all
  })

// ── Unified Chat API ──

/**
 * chatIds look like `match_<matchId>` or `org_<eventId>_<peerId>`. Splitting on
 * every underscore silently mangled ids containing one, so parse positionally.
 */
function parseChatId(
  chatId: string,
): { type: 'match'; matchId: string } | { type: 'org'; eventId: string; peerId: string } {
  if (chatId.startsWith('match_')) {
    const matchId = chatId.slice('match_'.length)
    if (!matchId) throw new Error('Invalid chat id')
    return { type: 'match', matchId }
  }

  if (chatId.startsWith('org_')) {
    const rest = chatId.slice('org_'.length)
    const separator = rest.indexOf('_')
    if (separator <= 0) throw new Error('Invalid chat id')
    const eventId = rest.slice(0, separator)
    const peerId = rest.slice(separator + 1)
    if (!eventId || !peerId) throw new Error('Invalid chat id')
    return { type: 'org', eventId, peerId }
  }

  throw new Error('Unknown chat type')
}

export const getChatMessages = createServerFn({ method: 'GET' })
  .inputValidator(
    z.union([
      z.string(),
      z.object({
        chatId: z.string(),
        // Cursor is the oldest message already held by the client; paging walks
        // backwards through history.
        before: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(MESSAGE_PAGE_SIZE),
      }),
    ]),
  )
  .handler(async ({ data }) => {
    const session = await requireSession()
    const myId = session.user.id

    const chatId = typeof data === 'string' ? data : data.chatId
    const before = typeof data === 'string' ? undefined : data.before
    const limit = typeof data === 'string' ? MESSAGE_PAGE_SIZE : data.limit

    const parsed = parseChatId(chatId)

    if (parsed.type === 'match') {
      const match = await prisma.eventMatch.findFirst({
        where: { id: parsed.matchId, OR: [{ user1Id: myId }, { user2Id: myId }] },
      })
      if (!match) throw new Error('Match not found')

      // Fetch newest-first with a limit, then reverse — loading an entire
      // thread on every open does not scale with conversation length.
      const page = await prisma.eventMessage.findMany({
        where: { matchId: parsed.matchId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(before && { cursor: { id: before }, skip: 1 }),
      })

      const hasMore = page.length > limit
      const msgs = (hasMore ? page.slice(0, limit) : page).reverse()

      return {
        type: 'match' as const,
        peerId: match.user1Id === myId ? match.user2Id : match.user1Id,
        messagesUnlockedAt: match.messagesUnlockedAt,
        messages: msgs.map((m) => ({ ...m, isMine: m.senderId === myId })),
        nextCursor: hasMore ? msgs[0]?.id ?? null : null,
      }
    }

    const { eventId, peerId } = parsed

    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true } })
    if (!event) throw new Error('Event not found')

    const [meAttendee, peerAttendee] = await Promise.all([
      prisma.eventAttendee.findFirst({
        where: { eventId, userId: myId, leftAt: null },
        select: { id: true },
      }),
      prisma.eventAttendee.findFirst({
        where: { eventId, userId: peerId, leftAt: null },
        select: { id: true },
      }),
    ])

    if (!meAttendee) throw new Error('You must be attending this event')
    if (!peerAttendee) throw new Error('The other user is not attending this event')

    const page = await prisma.eventOrganizerMessage.findMany({
      where: {
        eventId,
        OR: [
          { senderId: myId, receiverId: peerId },
          { senderId: peerId, receiverId: myId },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(before && { cursor: { id: before }, skip: 1 }),
    })

    const hasMore = page.length > limit
    const msgs = (hasMore ? page.slice(0, limit) : page).reverse()

    return {
      type: 'organizer' as const,
      peerId,
      eventId,
      messages: msgs.map((m) => ({ ...m, isMine: m.senderId === myId })),
      nextCursor: hasMore ? msgs[0]?.id ?? null : null,
    }
  })

async function assertNotBlocked(myId: string, peerId: string) {
  const block = await prisma.userBlock.findFirst({
    where: {
      OR: [
        { blockerId: myId, blockedId: peerId },
        { blockerId: peerId, blockedId: myId },
      ],
    },
    select: { id: true },
  })
  if (block) throw new Error('Unable to send message')
}

export const sendChatMessage = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    chatId: z.string(),
    // min(1) — the old schema accepted empty strings and stored them.
    content: z.string().min(1).max(2000),
    type: z.enum(['text', 'voice']).optional(),
    audioUrl: z.string().url().max(2048).optional(),
  }))
  .handler(async ({ data }) => {
    const session = await requireSession()
    const myId = session.user.id
    const { chatId, type, audioUrl } = data

    const throttle = await messageRateLimit(getUserScopedIdentifier(myId))
    if (!throttle.success) {
      throw new Error('You are sending messages too quickly. Please slow down.')
    }

    // The other implementation of this handler (swipes.ts sendMessage) applied
    // the sanitizer and this one didn't. React escapes on render, so this was
    // never live XSS — but it left the stored value one
    // dangerouslySetInnerHTML away from being one.
    const content = sanitizeText(data.content)
    if (!content) throw new Error('Message cannot be empty')

    // audioUrl arrives from the client. Pin it to our own bucket so an
    // attacker cannot get an arbitrary third-party URL rendered into an
    // <audio src> in someone else's chat.
    if (audioUrl && !audioUrl.startsWith(`${R2_PUBLIC_URL}/`)) {
      throw new Error('Invalid audio URL')
    }

    const parsed = parseChatId(chatId)

    if (parsed.type === 'match') {
      const { matchId } = parsed
      const match = await prisma.eventMatch.findFirst({
        where: { id: matchId, OR: [{ user1Id: myId }, { user2Id: myId }] },
      })
      if (!match) throw new Error('Match not found')

      const peerId = match.user1Id === myId ? match.user2Id : match.user1Id
      await assertNotBlocked(myId, peerId)

      // Mystery mode: unlock photos after 10 messages
      const existingCount = await prisma.eventMessage.count({ where: { matchId } })
      let unlocked = false
      if (!match.messagesUnlockedAt && existingCount >= 10) {
        const result = await prisma.eventMatch.updateMany({
          where: { id: matchId, messagesUnlockedAt: null },
          data: { messagesUnlockedAt: new Date() },
        })
        unlocked = result.count > 0
      }

      const message = await prisma.eventMessage.create({
        data: {
          matchId,
          senderId: myId,
          content,
          type: type === 'voice' ? 'voice' : 'text',
          audioUrl: audioUrl || null,
        },
      })

      // Broadcast WebSocket message for instant delivery
      broadcastChatMessage(chatId, { ...message, isMine: false }, peerId)

      // Fire-and-forget: push delivery makes an HTTP call per subscription and
      // must not sit in the critical path of sending a message.
      void createNotification({
        userId: peerId,
        type: 'message',
        title: 'New Message',
        body: content.slice(0, 100),
        link: `/chats/${chatId}`,
      }).catch((err) => console.warn('[notify] message notification failed:', err))

      return { ...message, isMine: true, unlocked }
    }

    const { eventId, peerId } = parsed

    if (type === 'voice') {
      throw new Error('Voice messages are not supported in organizer chats')
    }

    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true } })
    if (!event) throw new Error('Event not found')

    const [meAttendee, peerAttendee] = await Promise.all([
      prisma.eventAttendee.findFirst({
        where: { eventId, userId: myId, leftAt: null },
        select: { id: true },
      }),
      prisma.eventAttendee.findFirst({
        where: { eventId, userId: peerId, leftAt: null },
        select: { id: true },
      }),
    ])

    if (!meAttendee) throw new Error('You must be attending this event')
    if (!peerAttendee) throw new Error('The other user is not attending this event')

    await assertNotBlocked(myId, peerId)

    const message = await prisma.eventOrganizerMessage.create({
      data: { eventId, senderId: myId, receiverId: peerId, content },
    })

    broadcastChatMessage(chatId, { ...message, isMine: false }, peerId)

    void createNotification({
      userId: peerId,
      type: 'message',
      title: 'New Message',
      body: content.slice(0, 100),
      link: `/chats/${chatId}`,
    }).catch((err) => console.warn('[notify] message notification failed:', err))

    return { ...message, isMine: true }
  })

export const uploadVoiceMessage = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    base64Audio: z.string().min(1),
    matchId: z.string().min(1),
  }))
  .handler(async ({ data }) => {
    const session = await requireSession()
    const myId = session.user.id

    const throttle = await voiceUploadRateLimit(getUserScopedIdentifier(myId))
    if (!throttle.success) {
      throw new Error('Too many voice messages. Please slow down.')
    }

    // Reject oversized payloads before decoding — Buffer.from would otherwise
    // allocate the whole thing first, which is exactly the memory an attacker
    // wants to make us spend.
    if (data.base64Audio.length > MAX_AUDIO_BASE64_LENGTH) {
      throw new Error('Audio file too large')
    }

    // Verify user is part of the match
    const match = await prisma.eventMatch.findFirst({
      where: { id: data.matchId, OR: [{ user1Id: myId }, { user2Id: myId }] },
      select: { id: true },
    })
    if (!match) throw new Error('Match not found')

    // Validate data URL prefix
    if (!/^data:audio\/(webm|ogg|mp4|mpeg);base64,/.test(data.base64Audio)) {
      throw new Error('Invalid audio format')
    }

    const base64Data = data.base64Audio.split(',')[1]
    if (!base64Data) throw new Error('Invalid audio data')

    const buffer = Buffer.from(base64Data, 'base64')

    if (buffer.length > MAX_AUDIO_BYTES) {
      throw new Error('Audio file too large')
    }

    const key = `voice/${data.matchId}/${randomUUID()}.webm`

    await r2Client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: 'audio/webm',
      })
    )

    return { audioUrl: `${R2_PUBLIC_URL}/${key}` }
  })

export const getIcebreakers = createServerFn({ method: 'GET' })
  .inputValidator(z.string())
  .handler(async ({ data: matchId }) => {
    const session = await requireSession()
    const myId = session.user.id

    const match = await prisma.eventMatch.findFirst({
      where: { id: matchId, OR: [{ user1Id: myId }, { user2Id: myId }] },
    })
    if (!match) throw new Error('Match not found')

    const otherId = match.user1Id === myId ? match.user2Id : match.user1Id

    const [myProfile, otherProfile] = await Promise.all([
      prisma.profile.findUnique({ where: { userId: myId } }),
      prisma.profile.findUnique({ where: { userId: otherId } }),
    ])

    const myInterests = myProfile?.interests ?? []
    const otherInterests = otherProfile?.interests ?? []
    const shared = myInterests.filter((i) => otherInterests.includes(i))

    const suggestions: { id: string; text: string }[] = []

    if (shared.length > 0) {
      for (let i = 0; i < Math.min(shared.length, 3); i++) {
        suggestions.push({
          id: `ice-${i}`,
          text: `I see you both love ${shared[i]}! What's your favorite thing about it?`,
        })
      }
    }

    const fallback = [
      "Hey! How's the event going for you?",
      "What's been the highlight of tonight so far?",
      'Any recommendations at this event?',
    ]

    while (suggestions.length < 3) {
      suggestions.push({
        id: `ice-fb-${suggestions.length}`,
        text: fallback[suggestions.length],
      })
    }

    return suggestions.slice(0, 3)
  })

export const markChatRead = createServerFn({ method: 'POST' })
  .inputValidator(z.string())
  .handler(async ({ data: chatId }) => {
    const session = await requireSession()
    const myId = session.user.id
    const parsed = parseChatId(chatId)

    if (parsed.type === 'match') {
      const match = await prisma.eventMatch.findFirst({
        where: { id: parsed.matchId, OR: [{ user1Id: myId }, { user2Id: myId }] },
        select: { id: true },
      })
      if (!match) throw new Error('Match not found')

      await prisma.eventMessage.updateMany({
        where: { matchId: parsed.matchId, senderId: { not: myId }, readAt: null },
        data: { readAt: new Date() },
      })

      return { success: true }
    }

    // Scoped to messages addressed to me, so there is nothing to authorize
    // beyond the session itself.
    await prisma.eventOrganizerMessage.updateMany({
      where: {
        eventId: parsed.eventId,
        senderId: parsed.peerId,
        receiverId: myId,
        readAt: null,
      },
      data: { readAt: new Date() },
    })

    return { success: true }
  })
