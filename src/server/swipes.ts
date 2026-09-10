import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { prisma } from '#/db'
import { requireSession } from '#/server/auth'
import { createNotification } from './notifications.server'
import { rateLimit } from '#/lib/rate-limit'
import { getUserScopedIdentifier } from '#/lib/rate-limit.server'
import { broadcastMatchCreated } from './websocket-broadcast'
import { awardBadgeIfNotExists } from './badges.server'
import { findOrCreateMatch } from './matches.server'
import { getEventProfiles, getGlobalProfiles } from '#/server/events'

const swipeRateLimit = rateLimit({ windowMs: 60 * 1000, maxRequests: 30 })

export const recordSwipe = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    eventId: z.string().optional(),
    swipedId: z.string(),
    direction: z.enum(['like', 'pass', 'super']),
  }))
  .handler(async ({ data }) => {
    const session = await requireSession()
    const swiperId = session.user.id
    const eventId = data.eventId ?? null

    const rateLimitResult = await swipeRateLimit(getUserScopedIdentifier(swiperId))

    if (!rateLimitResult.success) {
      throw new Error('Too many swipes. Please slow down.')
    }

    if (swiperId === data.swipedId) {
      throw new Error('Cannot swipe yourself')
    }

    // A block in either direction stops the swipe outright. This used to be
    // applied only when reading getLikes, so a blocked user could still like
    // you — and each like fired a push notification.
    const [target, block] = await Promise.all([
      prisma.user.findUnique({
        where: { id: data.swipedId },
        select: { id: true, disabledAt: true },
      }),
      prisma.userBlock.findFirst({
        where: {
          OR: [
            { blockerId: swiperId, blockedId: data.swipedId },
            { blockerId: data.swipedId, blockedId: swiperId },
          ],
        },
        select: { id: true },
      }),
    ])

    if (!target || target.disabledAt || block) {
      throw new Error('This profile is no longer available')
    }

    if (eventId) {
      const [swiperAttendee, swipedAttendee] = await Promise.all([
        prisma.eventAttendee.findFirst({
          where: { eventId, userId: swiperId, leftAt: null },
          select: { id: true },
        }),
        prisma.eventAttendee.findFirst({
          where: { eventId, userId: data.swipedId, leftAt: null },
          select: { id: true },
        }),
      ])

      if (!swiperAttendee || !swipedAttendee) {
        throw new Error('Both users must be active attendees of the event')
      }
    }

    // Check for existing swipe to avoid duplicate side effects
    const existing = await prisma.eventSwipe.findFirst({
      where: { eventId, swiperId, swipedId: data.swipedId },
    })

    if (existing && existing.direction === data.direction) {
      // Same direction already recorded — do nothing
      return existing
    }

    const swipe = existing
      ? await prisma.eventSwipe.update({
          where: { id: existing.id },
          data: { direction: data.direction },
        })
      : await prisma.eventSwipe.create({
          data: { eventId, swiperId, swipedId: data.swipedId, direction: data.direction },
        })

    if (data.direction === 'like' || data.direction === 'super') {
      const [mutual, swiperProfile] = await Promise.all([
        prisma.eventSwipe.findFirst({
          where: {
            eventId,
            swiperId: data.swipedId,
            swipedId: swiperId,
            direction: { in: ['like', 'super'] },
          },
        }),
        prisma.profile.findUnique({ where: { userId: swiperId }, select: { name: true } }),
      ])

      if (mutual) {
        const { match, created } = await findOrCreateMatch(eventId, swiperId, data.swipedId)

        if (created) {
          // Broadcast WebSocket notification for instant match alert
          broadcastMatchCreated(eventId, swiperId, data.swipedId, match.id)

          // Award first_match badge to both users
          await Promise.all([
            awardBadgeIfNotExists(swiperId, 'first_match'),
            awardBadgeIfNotExists(data.swipedId, 'first_match'),
          ])

          // Notify both users about the match
          await Promise.all([
            createNotification({
              userId: swiperId,
              type: 'match',
              title: "It's a Match!",
              body: 'You matched with someone. Start chatting!',
              link: `/chats/match_${match.id}`,
            }),
            createNotification({
              userId: data.swipedId,
              type: 'match',
              title: "It's a Match!",
              body: 'You matched with someone. Start chatting!',
              link: `/chats/match_${match.id}`,
            }),
          ])
        }

        return match
      }

      // Not mutual yet — notify the swiped user they got a like
      await createNotification({
        userId: data.swipedId,
        type: 'like',
        title: 'New Like',
        body: `${swiperProfile?.name ?? 'Someone'} liked you`,
        link: '/likes',
      })
    }

    return swipe
  })

export const rewindLastSwipe = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    eventId: z.string().optional(),
    swipedId: z.string(),
  }))
  .handler(async ({ data }) => {
    const session = await requireSession()
    const swiperId = session.user.id
    const eventId = data.eventId ?? null

    const swipe = await prisma.eventSwipe.findFirst({
      where: { eventId, swiperId, swipedId: data.swipedId },
    })
    if (!swipe) {
      return { success: false, message: 'Nothing to rewind' }
    }

    const [u1, u2] = [swiperId, data.swipedId].sort()
    const existingMatch = await prisma.eventMatch.findFirst({
      where: { eventId, user1Id: u1, user2Id: u2 },
    })
    if (existingMatch) {
      return { success: false, message: "You already matched — can't rewind" }
    }

    await prisma.eventSwipe.delete({ where: { id: swipe.id } })

    return { success: true }
  })

export const getLikes = createServerFn({ method: 'GET' })
  .handler(async () => {
    const session = await requireSession()

    const attendedEvents = await prisma.eventAttendee.findMany({
      where: { userId: session.user.id },
      select: { eventId: true },
    })
    const eventIds = [...new Set(attendedEvents.map((a) => a.eventId))]

    const swipes = await prisma.eventSwipe.findMany({
      where: {
        OR: [{ eventId: null }, { eventId: { in: eventIds } }],
        swipedId: session.user.id,
        direction: { in: ['like', 'super'] },
      },
    })

    if (swipes.length === 0) return []

    const swiperIds = swipes.map((s) => s.swiperId)

    const [profiles, users] = await Promise.all([
      prisma.profile.findMany({ where: { userId: { in: swiperIds } } }),
      prisma.user.findMany({
        where: { id: { in: swiperIds } },
        select: { id: true, name: true, image: true, email: true, disabledAt: true },
      }),
    ])

    const userById = new Map(users.map((u) => [u.id, u]))
    const profileByUserId = new Map(profiles.map((p) => [p.userId, p]))

    // Exclude blocked users (bidirectional)
    const blockedRelations = await prisma.userBlock.findMany({
      where: {
        OR: [
          { blockerId: session.user.id, blockedId: { in: swiperIds } },
          { blockerId: { in: swiperIds }, blockedId: session.user.id },
        ],
      },
      select: { blockerId: true, blockedId: true },
    })
    const blockedIds = new Set<string>()
    for (const b of blockedRelations) {
      blockedIds.add(b.blockerId === session.user.id ? b.blockedId : b.blockerId)
    }
    const activeSwiperIds = [...new Set(swiperIds.filter((id) => !userById.get(id)?.disabledAt && !blockedIds.has(id)))]

    const swipeBySwiperId = new Map(swipes.map((s) => [s.swiperId, s]))

    return activeSwiperIds.map((userId) => {
      const profile = profileByUserId.get(userId)
      const user = userById.get(userId)
      const swipe = swipeBySwiperId.get(userId)
      return {
        ...(profile || {}),
        id: profile?.id ?? userId,
        userId,
        eventId: swipe?.eventId ?? '',
        name: profile?.name || user?.name || user?.email?.split('@')[0] || 'Unnamed',
        photos:
          profile?.photos && profile.photos.length > 0
            ? profile.photos
            : user?.image
              ? [user.image]
              : [],
        bio: profile?.bio ?? '',
        gender: profile?.gender ?? '',
        birthDate: profile?.birthDate ?? '',
        location: profile?.location ?? '',
        interests: profile?.interests ?? [],
        job: profile?.job ?? '',
        createdAt: profile?.createdAt ?? new Date(),
        updatedAt: profile?.updatedAt ?? new Date(),
      }
    })
  })

export const getMatches = createServerFn({ method: 'GET' })
  .handler(async () => {
    const session = await requireSession()

    const matches = await prisma.eventMatch.findMany({
      where: {
        OR: [
          { user1Id: session.user.id },
          { user2Id: session.user.id },
        ],
      },
      include: {
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
    })

    const peerIds = matches.map((m) =>
      m.user1Id === session.user.id ? m.user2Id : m.user1Id
    )

    const [profiles, users] = await Promise.all([
      prisma.profile.findMany({ where: { userId: { in: peerIds } } }),
      prisma.user.findMany({
        where: { id: { in: peerIds } },
        select: { id: true, name: true, image: true, disabledAt: true },
      }),
    ])

    const userById = new Map(users.map((u) => [u.id, u]))
    const profileByUserId = new Map(profiles.map((p) => [p.userId, p]))

    // Exclude blocked users (bidirectional)
    const blockedRelations = await prisma.userBlock.findMany({
      where: {
        OR: [
          { blockerId: session.user.id, blockedId: { in: peerIds } },
          { blockerId: { in: peerIds }, blockedId: session.user.id },
        ],
      },
      select: { blockerId: true, blockedId: true },
    })
    const blockedIds = new Set<string>()
    for (const b of blockedRelations) {
      blockedIds.add(b.blockerId === session.user.id ? b.blockedId : b.blockerId)
    }

    const activePeerIds = new Set(
      peerIds.filter((id) => !userById.get(id)?.disabledAt && !blockedIds.has(id))
    )

    const unreadGroups = matches.length > 0
      ? await prisma.eventMessage.groupBy({
          by: ['matchId'],
          where: {
            matchId: { in: matches.map((m) => m.id) },
            senderId: { not: session.user.id },
            readAt: null,
          },
          _count: { id: true },
        })
      : []
    const unreadCountByMatchId = new Map(unreadGroups.map((g) => [g.matchId, g._count.id]))

    return matches
      .filter((match) => {
        const peerId = match.user1Id === session.user.id ? match.user2Id : match.user1Id
        return activePeerIds.has(peerId)
      })
      .map((match) => {
        const peerId = match.user1Id === session.user.id ? match.user2Id : match.user1Id
        const profile = profileByUserId.get(peerId)
        const user = userById.get(peerId)
        const photos =
          profile?.photos && profile.photos.length > 0
            ? profile.photos
            : user?.image
              ? [user.image]
              : []
        return {
          id: match.id,
          eventId: match.eventId,
          peerId,
          peerName: profile?.name || user?.name || 'Unknown',
          peerPhoto: photos[0],
          lastMessage: match.messages[0]?.content ?? '',
          lastMessageAt: match.messages[0]?.createdAt ?? match.createdAt,
          unread: unreadCountByMatchId.get(match.id) ?? 0,
        }
      })
  })

// getMessages / sendMessage used to live here as well. They were superseded by
// the unified chat API in server/conversations.ts (getChatMessages /
// sendChatMessage), which handles both match and organizer threads, enforces
// blocks, and paginates. Two implementations of the same thing had already
// drifted apart — this one sanitized but skipped the block check, the other
// checked blocks but skipped sanitizing.

export const getSwipeDeck = createServerFn({ method: 'GET' })
  .inputValidator(
    z.object({
      eventId: z.string().optional(),
      intent: z.enum(['dating', 'friends', 'networking']).optional(),
      offset: z.number().int().min(0).max(10_000).default(0),
      limit: z.number().int().min(1).max(50).default(30),
    })
  )
  .handler(async ({ data }) => {
    // getEventProfiles/getGlobalProfiles handle boost sorting internally: boosted
    // profiles appear first, each group is shuffled separately, then concatenated.
    // Both return a page — { items, nextOffset } — rather than the whole pool.
    if (data.eventId) {
      return getEventProfiles({
        data: {
          eventId: data.eventId,
          intent: data.intent,
          offset: data.offset,
          limit: data.limit,
        },
      })
    }
    return getGlobalProfiles({
      data: { intent: data.intent, offset: data.offset, limit: data.limit },
    })
  })
