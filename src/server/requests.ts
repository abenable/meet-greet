import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import type { EventMessageRequest } from '@prisma/client'
import { prisma } from '#/db'
import { requireSession } from '#/server/auth'
import { createNotification } from './notifications.server'
import { findOrCreateMatch } from './matches.server'
import { rateLimit } from '#/lib/rate-limit'
import { getUserScopedIdentifier } from '#/lib/rate-limit.server'

const requestRateLimit = rateLimit({ windowMs: 60 * 60 * 1000, maxRequests: 30 })

export const sendMessageRequest = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    eventId: z.string().optional(),
    receiverId: z.string(),
  }))
  .handler(async ({ data }) => {
    const session = await requireSession()
    const senderId = session.user.id
    const eventId = data.eventId ?? null

    if (senderId === data.receiverId) {
      throw new Error('Cannot request yourself')
    }

    const throttle = await requestRateLimit(getUserScopedIdentifier(senderId))
    if (!throttle.success) {
      throw new Error('Too many message requests. Please slow down.')
    }

    // A block in either direction stops the request. This was missing, so a
    // blocked user could keep sending requests — each one a push notification.
    const [receiver, block] = await Promise.all([
      prisma.user.findUnique({
        where: { id: data.receiverId },
        select: { id: true, disabledAt: true },
      }),
      prisma.userBlock.findFirst({
        where: {
          OR: [
            { blockerId: senderId, blockedId: data.receiverId },
            { blockerId: data.receiverId, blockedId: senderId },
          ],
        },
        select: { id: true },
      }),
    ])

    if (!receiver || receiver.disabledAt || block) {
      throw new Error('This profile is no longer available')
    }

    if (eventId) {
      // Verify both are active attendees
      const [senderAttendee, receiverAttendee] = await Promise.all([
        prisma.eventAttendee.findFirst({
          where: { eventId, userId: senderId, leftAt: null },
          select: { id: true },
        }),
        prisma.eventAttendee.findFirst({
          where: { eventId, userId: data.receiverId, leftAt: null },
          select: { id: true },
        }),
      ])

      if (!senderAttendee || !receiverAttendee) {
        throw new Error('Both users must be active attendees')
      }
    }

    // Check if already matched
    const [u1, u2] = [senderId, data.receiverId].sort()
    const existingMatch = await prisma.eventMatch.findFirst({
      where: { eventId, user1Id: u1, user2Id: u2 },
      select: { id: true },
    })
    if (existingMatch) {
      throw new Error('You are already matched')
    }

    // Genuinely check both directions — the comment here claimed to, but the
    // query only looked at sender→receiver. Two people requesting each other
    // produced two pending rows instead of a match.
    const inbound = await prisma.eventMessageRequest.findFirst({
      where: { eventId, senderId: data.receiverId, receiverId: senderId, status: 'pending' },
    })
    if (inbound) {
      // They already asked us — treat this as an accept rather than a second
      // outstanding request.
      return acceptRequestInternal(inbound, senderId)
    }

    const existing = await prisma.eventMessageRequest.findFirst({
      where: { eventId, senderId, receiverId: data.receiverId },
    })

    if (existing) {
      if (existing.status === 'pending') {
        throw new Error('Request already sent')
      }
      if (existing.status === 'accepted') {
        throw new Error('Request already accepted')
      }
      // If declined, allow re-sending by updating
      const updated = await prisma.eventMessageRequest.update({
        where: { id: existing.id },
        data: { status: 'pending', updatedAt: new Date() },
      })
      await notifyRequestReceived(data.receiverId, senderId)
      return updated
    }

    const request = await prisma.eventMessageRequest.create({
      data: {
        eventId,
        senderId,
        receiverId: data.receiverId,
        status: 'pending',
      },
    })

    await notifyRequestReceived(data.receiverId, senderId)
    return request
  })

/**
 * Shared by acceptMessageRequest and by sendMessageRequest when it discovers
 * an inbound request from the same person.
 */
async function acceptRequestInternal(request: EventMessageRequest, accepterId: string) {
  const updated = await prisma.eventMessageRequest.update({
    where: { id: request.id },
    data: { status: 'accepted', updatedAt: new Date() },
  })

  // findOrCreateMatch is race-safe: the partial unique indexes on EventMatch
  // make a duplicate pair impossible, and a lost race becomes a read.
  const { match, created } = await findOrCreateMatch(
    request.eventId ?? null,
    request.senderId,
    request.receiverId,
  )

  if (created) {
    const otherId = request.senderId === accepterId ? request.receiverId : request.senderId
    await Promise.all([
      createNotification({
        userId: otherId,
        type: 'request_accepted',
        title: 'Request Accepted',
        body: 'Your message request was accepted. Start chatting!',
        link: `/chats/match_${match.id}`,
      }),
      createNotification({
        userId: accepterId,
        type: 'match',
        title: "It's a Match!",
        body: 'You accepted a message request. Start chatting!',
        link: `/chats/match_${match.id}`,
      }),
    ])
  }

  return updated
}

export const acceptMessageRequest = createServerFn({ method: 'POST' })
  .inputValidator(z.string()) // requestId
  .handler(async ({ data: requestId }) => {
    const session = await requireSession()
    const request = await prisma.eventMessageRequest.findUnique({
      where: { id: requestId },
    })

    if (!request) throw new Error('Request not found')
    if (request.receiverId !== session.user.id) throw new Error('Not authorized')
    if (request.status !== 'pending') throw new Error('Request already handled')

    return acceptRequestInternal(request, session.user.id)
  })

export const declineMessageRequest = createServerFn({ method: 'POST' })
  .inputValidator(z.string()) // requestId
  .handler(async ({ data: requestId }) => {
    const session = await requireSession()
    const request = await prisma.eventMessageRequest.findUnique({
      where: { id: requestId },
    })

    if (!request) throw new Error('Request not found')
    if (request.receiverId !== session.user.id) throw new Error('Not authorized')
    // accept guarded on this and decline did not, so an accepted request could
    // be flipped to declined after the match already existed — and declined
    // requests are re-sendable, which made the whole cycle repeatable.
    if (request.status !== 'pending') throw new Error('Request already handled')

    return prisma.eventMessageRequest.update({
      where: { id: requestId },
      data: { status: 'declined', updatedAt: new Date() },
    })
  })

export const getIncomingMessageRequests = createServerFn({ method: 'GET' })
  .handler(async () => {
    const session = await requireSession()

    const requests = await prisma.eventMessageRequest.findMany({
      where: { receiverId: session.user.id, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    })

    if (requests.length === 0) return []

    const senderIds = requests.map((r) => r.senderId)
    const eventIds = [...new Set(requests.map((r) => r.eventId).filter((id): id is string => !!id))]

    const [profiles, users, events] = await Promise.all([
      prisma.profile.findMany({ where: { userId: { in: senderIds } } }),
      prisma.user.findMany({
        where: { id: { in: senderIds } },
        select: { id: true, name: true, image: true, email: true, disabledAt: true },
      }),
      prisma.event.findMany({
        where: { id: { in: eventIds } },
        select: { id: true, name: true },
      }),
    ])

    const userById = new Map(users.map((u) => [u.id, u]))
    const profileByUserId = new Map(profiles.map((p) => [p.userId, p]))
    const eventById = new Map(events.map((e) => [e.id, e]))

    return requests
      .filter((r) => !userById.get(r.senderId)?.disabledAt)
      .map((r) => {
        const profile = profileByUserId.get(r.senderId)
        const user = userById.get(r.senderId)
        return {
          id: r.id,
          eventId: r.eventId,
          eventName: r.eventId ? (eventById.get(r.eventId)?.name ?? '') : '',
          senderId: r.senderId,
          senderName: profile?.name || user?.name || user?.email?.split('@')[0] || 'Unnamed',
          senderPhotos:
            profile?.photos && profile.photos.length > 0
              ? profile.photos
              : user?.image
                ? [user.image]
                : [],
          senderBio: profile?.bio ?? '',
          senderLocation: profile?.location ?? '',
          createdAt: r.createdAt,
        }
      })
  })

export const getOutgoingMessageRequests = createServerFn({ method: 'GET' })
  .handler(async () => {
    const session = await requireSession()

    const requests = await prisma.eventMessageRequest.findMany({
      where: { senderId: session.user.id, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    })

    if (requests.length === 0) return []

    const receiverIds = requests.map((r) => r.receiverId)
    const eventIds = [...new Set(requests.map((r) => r.eventId).filter((id): id is string => !!id))]

    const [profiles, users, events] = await Promise.all([
      prisma.profile.findMany({ where: { userId: { in: receiverIds } } }),
      prisma.user.findMany({
        where: { id: { in: receiverIds } },
        select: { id: true, name: true, image: true, email: true, disabledAt: true },
      }),
      prisma.event.findMany({
        where: { id: { in: eventIds } },
        select: { id: true, name: true },
      }),
    ])

    const userById = new Map(users.map((u) => [u.id, u]))
    const profileByUserId = new Map(profiles.map((p) => [p.userId, p]))
    const eventById = new Map(events.map((e) => [e.id, e]))

    return requests
      .filter((r) => !userById.get(r.receiverId)?.disabledAt)
      .map((r) => {
        const profile = profileByUserId.get(r.receiverId)
        const user = userById.get(r.receiverId)
        return {
          id: r.id,
          eventId: r.eventId,
          eventName: r.eventId ? (eventById.get(r.eventId)?.name ?? '') : '',
          receiverId: r.receiverId,
          receiverName: profile?.name || user?.name || user?.email?.split('@')[0] || 'Unnamed',
          receiverPhotos:
            profile?.photos && profile.photos.length > 0
              ? profile.photos
              : user?.image
                ? [user.image]
                : [],
          createdAt: r.createdAt,
        }
      })
  })

async function notifyRequestReceived(receiverId: string, senderId: string) {
  const senderProfile = await prisma.profile.findUnique({
    where: { userId: senderId },
    select: { name: true },
  })
  await createNotification({
    userId: receiverId,
    type: 'request',
    title: 'New Message Request',
    body: `${senderProfile?.name ?? 'Someone'} wants to chat with you`,
    link: '/likes',
  })
}
