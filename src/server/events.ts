import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { Prisma } from '@prisma/client'
import { prisma } from '#/db'
import { requireSession } from '#/server/auth'
import { broadcastToEvent } from '#/server/websocket-broadcast'
import { r2Client, R2_BUCKET_NAME, R2_PUBLIC_URL } from '#/lib/r2'
import { rateLimit } from '#/lib/rate-limit'
import { sanitizeText } from '#/lib/sanitize'
import { awardBadgeIfNotExists } from './badges.server'
import type { Profile } from '@prisma/client'

/** Reports are an abuse vector in both directions; cap how fast they arrive. */
const reportRateLimit = rateLimit({ windowMs: 60 * 60 * 1000, maxRequests: 10 })
/** Creating events writes rows and allocates R2 keys. */
const createEventRateLimit = rateLimit({ windowMs: 60 * 60 * 1000, maxRequests: 10 })
/** Posting to an event feed. */
const eventPostRateLimit = rateLimit({ windowMs: 60 * 1000, maxRequests: 20 })

const MAX_BASE64_LENGTH = 15_000_000 // ~10MB JPEG after encoding

/** Hard cap on how many candidates a single deck request will consider. */
const DECK_CANDIDATE_LIMIT = 400
/** How many profiles a single deck response returns. */
const DECK_PAGE_SIZE = 30

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8

/**
 * Event codes double as an access control for private events, so they are
 * drawn from a CSPRNG rather than Math.random and widened from 6 to 8
 * characters (32^8 ≈ 1.1e12 instead of 32^6 ≈ 1.1e9).
 */
function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH)
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length]
  }
  return code
}

/**
 * Create the event, retrying on the (astronomically unlikely) unique-code
 * collision that previously surfaced as an unhandled 500.
 */
async function createEventWithUniqueCode(
  tx: Prisma.TransactionClient,
  data: Omit<Prisma.EventUncheckedCreateInput, 'code'>,
) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await tx.event.create({ data: { ...data, code: generateCode() } })
    } catch (err) {
      const isCodeCollision =
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        String((err.meta as { target?: string[] } | undefined)?.target ?? '').includes('code')
      if (!isCodeCollision) throw err
    }
  }
  throw new Error('Could not allocate an event code. Please try again.')
}

function seededShuffle<T>(arr: T[], seed: string): T[] {
  const result = [...arr]
  // Simple hash of the seed string
  let s = 0
  for (let i = 0; i < seed.length; i++) {
    s = ((s << 5) - s + seed.charCodeAt(i)) | 0
  }
  // Xorshift PRNG
  const rand = () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    s = s | 0
    return ((s >>> 0) % 100000) / 100000
  }
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

function calculateAge(birthDate: string | null | undefined): number | null {
  if (!birthDate) return null
  const dob = new Date(birthDate)
  if (Number.isNaN(dob.getTime())) return null
  const now = new Date()
  let age = now.getFullYear() - dob.getFullYear()
  const hasHadBirthdayThisYear =
    now.getMonth() > dob.getMonth() ||
    (now.getMonth() === dob.getMonth() && now.getDate() >= dob.getDate())
  if (!hasHadBirthdayThisYear) age -= 1
  return age
}

/** Distinct reporters required before auto-moderation hides someone. */
export const FLAG_THRESHOLD = 3
const FLAG_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Auto-moderation filter: users reported by at least FLAG_THRESHOLD *distinct*
 * reporters in the last 24h are hidden from discovery and attendee lists.
 *
 * Counting rows rather than distinct reporters let a single account hide any
 * user by filing two reports. A unique index on (reporterId, reportedId,
 * eventId) now prevents the duplicates at write time, and this query counts
 * distinct reporters so the threshold means what it says either way.
 */
async function getFlaggedUserIds(): Promise<Set<string>> {
  const since = new Date(Date.now() - FLAG_WINDOW_MS)

  const rows = await prisma.$queryRaw<Array<{ reportedId: string }>>`
    SELECT "reportedId"
    FROM "Report"
    WHERE "status" = 'pending' AND "createdAt" >= ${since}
    GROUP BY "reportedId"
    HAVING COUNT(DISTINCT "reporterId") >= ${FLAG_THRESHOLD}
  `

  return new Set(rows.map((r) => r.reportedId))
}

export const listEvents = createServerFn({ method: 'GET' })
  .inputValidator(z.object({
    cursor: z.string().optional(),
    limit: z.number().min(1).max(50).default(20),
  }).optional())
  .handler(async ({ data }) => {
    const limit = data?.limit || 20
    const cursor = data?.cursor

    return prisma.event.findMany({
      // Ended and deactivated events were still being listed publicly.
      where: {
        isPublic: true,
        isActive: true,
        OR: [{ endedAt: null }, { endedAt: { gt: new Date() } }],
      },
      select: {
        id: true,
        name: true,
        photo: true,
        description: true,
        location: true,
        createdAt: true,
        startsAt: true,
        maxAttendees: true,
        mysteryMode: true,
        sponsorName: true,
        sponsorLogo: true,
        sponsorFrameUrl: true,
        _count: { select: { attendees: { where: { leftAt: null } } } },
      },
      // id as a tiebreaker: cursor pagination on a non-unique ordering
      // key can skip or repeat rows when timestamps collide.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    }).then(events => {
      const hasMore = events.length > limit
      const items = hasMore ? events.slice(0, limit) : events
      return {
        items,
        nextCursor: hasMore ? items[items.length - 1].id : null,
      }
    })
  })

export const getEventByCode = createServerFn({ method: 'GET' })
  .inputValidator(z.string())
  .handler(async ({ data: code }) => {
    const event = await prisma.event.findUnique({
      where: { code: code.toUpperCase() },
      include: {
        _count: { select: { attendees: { where: { leftAt: null } } } },
      },
    })

    if (!event) return null

    const now = new Date()
    if (!event.isActive) return null
    if (event.endedAt && event.endedAt <= now) return null

    await maybePromoteWaitlist(event.id)

    // Re-fetch to get updated count after promotion
    return prisma.event.findUnique({
      where: { id: event.id },
      include: {
        _count: { select: { attendees: { where: { leftAt: null } } } },
      },
    })
  })

export const getEventById = createServerFn({ method: 'GET' })
  .inputValidator(z.string())
  .handler(async ({ data: id }) => {
    const session = await requireSession()

    await maybePromoteWaitlist(id)

    const event = await prisma.event.findUnique({
      where: { id },
      include: {
        _count: { select: { attendees: { where: { leftAt: null } } } },
      },
    })

    if (!event) return null

    const isCreator = event.createdById === session.user.id
    if (isCreator) return event

    // A private event is only visible to people who are actually connected to
    // it. Previously any signed-in user who knew (or guessed) an id got the
    // full record back minus the join code.
    if (!event.isPublic) {
      const [attendee, waitlisted] = await Promise.all([
        // leftAt: null — a former attendee, or one the organizer removed,
        // keeps their row, so an unfiltered lookup would let them keep reading
        // a private event after being removed from it.
        prisma.eventAttendee.findFirst({
          where: { eventId: id, userId: session.user.id, leftAt: null },
          select: { id: true },
        }),
        prisma.eventWaitlist.findUnique({
          where: { eventId_userId: { eventId: id, userId: session.user.id } },
          select: { id: true },
        }),
      ])
      if (!attendee && !waitlisted) return null
    }

    const { code, ...rest } = event
    return rest
  })

async function leaveAllActiveEvents(userId: string, tx?: any) {
  const db = tx || prisma
  await db.eventAttendee.updateMany({
    where: { userId, leftAt: null },
    data: { leftAt: new Date() },
  })
}

async function getCurrentActiveEvent(userId: string) {
  const attendee = await prisma.eventAttendee.findFirst({
    where: { userId, leftAt: null },
    include: { event: { select: { id: true, name: true } } },
  })
  return attendee?.event ?? null
}

/**
 * Move waitlisted users into the event, up to remaining capacity.
 *
 * Two things changed here. First, capacity is now read *inside* a transaction
 * that holds a row lock on the event, so two concurrent promotions can no
 * longer both see the same free slots and push the event over maxAttendees.
 * Second, this is no longer called from read handlers — see
 * maybePromoteWaitlist() for the throttled entry point used by GET paths.
 */
async function promoteWaitlist(eventId: string) {
  await prisma.$transaction(async (tx) => {
    // SELECT ... FOR UPDATE serialises promotion for this event.
    const locked = await tx.$queryRaw<Array<{ id: string; maxAttendees: number | null; startsAt: Date | null; endedAt: Date | null }>>`
      SELECT "id", "maxAttendees", "startsAt", "endedAt"
      FROM "Event"
      WHERE "id" = ${eventId}
      FOR UPDATE
    `
    const event = locked[0]
    if (!event) return

    const now = new Date()
    if (event.endedAt && event.endedAt <= now) return
    if (event.startsAt && event.startsAt > now) return

    const activeCount = await tx.eventAttendee.count({
      where: { eventId, leftAt: null },
    })

    const slotsAvailable =
      event.maxAttendees === null ? Number.MAX_SAFE_INTEGER : event.maxAttendees - activeCount
    if (slotsAvailable <= 0) return

    const toPromote = await tx.eventWaitlist.findMany({
      where: { eventId },
      orderBy: { joinedAt: 'asc' },
      take: Math.min(slotsAvailable, 500),
      select: { id: true, userId: true },
    })
    if (toPromote.length === 0) return

    const userIds = toPromote.map((w) => w.userId)

    await tx.eventAttendee.updateMany({
      where: { eventId, userId: { in: userIds } },
      data: { leftAt: null, removedById: null, removedAt: null },
    })
    await tx.eventAttendee.createMany({
      data: userIds.map((userId) => ({ eventId, userId })),
      skipDuplicates: true,
    })
    await tx.eventWaitlist.deleteMany({
      where: { id: { in: toPromote.map((w) => w.id) } },
    })
  })
}

/**
 * Read handlers used to run the full promotion transaction on every call,
 * turning a page view into a write storm. This throttles promotion to at most
 * once per event per interval, and swallows failures so a read never 500s
 * because of housekeeping.
 */
const PROMOTE_THROTTLE_MS = 30_000
const lastPromotedAt = new Map<string, number>()

async function maybePromoteWaitlist(eventId: string) {
  const now = Date.now()
  const last = lastPromotedAt.get(eventId) ?? 0
  if (now - last < PROMOTE_THROTTLE_MS) return
  lastPromotedAt.set(eventId, now)

  // Keep the throttle map from growing without bound on a long-lived process.
  if (lastPromotedAt.size > 10_000) {
    for (const [key, at] of lastPromotedAt) {
      if (now - at > PROMOTE_THROTTLE_MS) lastPromotedAt.delete(key)
    }
  }

  try {
    await promoteWaitlist(eventId)
  } catch (err) {
    console.warn('[waitlist] promotion failed for', eventId, err)
  }
}

export const createEvent = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    name: z.string().min(1).max(100),
    photo: z.string().optional(),
    description: z.string().max(500).optional(),
    location: z.string().max(200).optional(),
    maxAttendees: z.number().int().min(1).max(1000).optional(),
    startsAt: z.string().datetime().optional(),
    isPublic: z.boolean().optional(),
    mysteryMode: z.boolean().optional(),
    force: z.boolean().optional(),
    sponsorName: z.string().max(200).optional(),
    sponsorLogo: z.string().url().max(1000).optional(),
    sponsorFrameUrl: z.string().url().max(1000).optional(),
  }))
  .handler(async ({ data }) => {
    const session = await requireSession()

    const throttle = await createEventRateLimit(`create-event:${session.user.id}`)
    if (!throttle.success) {
      return { success: false as const, message: 'You are creating events too quickly. Try again later.' }
    }

    if (!data.force) {
      const currentEvent = await getCurrentActiveEvent(session.user.id)
      if (currentEvent) {
        return { success: false, needsConfirm: true as const, currentEvent }
      }
    }

    const photoIsBase64 = data.photo && data.photo.startsWith('data:image')
    if (photoIsBase64 && data.photo!.length > MAX_BASE64_LENGTH) {
      return { success: false as const, message: 'Event photo is too large.' }
    }

    const event = await prisma.$transaction(async (tx) => {
      await leaveAllActiveEvents(session.user.id, tx)

      const event = await createEventWithUniqueCode(tx, {
        name: sanitizeText(data.name),
        photo: photoIsBase64 ? null : data.photo ?? null,
        description: data.description ? sanitizeText(data.description) : undefined,
        location: data.location ? sanitizeText(data.location) : undefined,
        maxAttendees: data.maxAttendees,
        startsAt: data.startsAt ? new Date(data.startsAt) : null,
        createdById: session.user.id,
        isPublic: data.isPublic ?? true,
        mysteryMode: data.mysteryMode ?? false,
        sponsorName: data.sponsorName ? sanitizeText(data.sponsorName) : undefined,
        sponsorLogo: data.sponsorLogo,
        sponsorFrameUrl: data.sponsorFrameUrl,
      })
      await tx.eventAttendee.create({
        data: { eventId: event.id, userId: session.user.id },
      })
      return event
    })

    // Upload base64 photo to R2 after event is created so we know the eventId
    if (photoIsBase64) {
      try {
        const key = `events/${event.id}/photo-${crypto.randomUUID()}.jpg`
        const base64Data = data.photo!.split(',')[1]
        if (base64Data) {
          const buffer = Buffer.from(base64Data, 'base64')
          await r2Client.send(
            new PutObjectCommand({
              Bucket: R2_BUCKET_NAME,
              Key: key,
              Body: buffer,
              ContentType: 'image/jpeg',
            })
          )
          const publicUrl = `${R2_PUBLIC_URL}/${key}`
          await prisma.event.update({
            where: { id: event.id },
            data: { photo: publicUrl },
          })
          event.photo = publicUrl
        }
      } catch (err: any) {
        console.error('[Create Event] R2 photo upload failed:', err)
      }
    }

    // Award event_host badge
    await awardBadgeIfNotExists(session.user.id, 'event_host')

    return { success: true as const, event }
  })

export const joinEvent = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    code: z.string(),
    force: z.boolean().optional(),
  }))
  .handler(async ({ data }) => {
    const session = await requireSession()
    const now = new Date()

    const event = await prisma.event.findUnique({
      where: { code: data.code.toUpperCase() },
      include: {
        _count: { select: { attendees: { where: { leftAt: null } } } },
      },
    })

    if (!event) {
      return { success: false, message: 'Event not found' }
    }

    if (!event.isActive) {
      return { success: false, message: 'Event is not active' }
    }

    if (event.endedAt && event.endedAt <= now) {
      return { success: false, message: 'Event has ended' }
    }

    const blocked = await prisma.eventBlockedUser.findUnique({
      where: {
        eventId_userId: { eventId: event.id, userId: session.user.id },
      },
    })
    if (blocked) {
      return { success: false, message: 'You have been blocked from this event' }
    }

    // Promote waitlist in case event has just started
    await promoteWaitlist(event.id)

    const existing = await prisma.eventAttendee.findUnique({
      where: {
        eventId_userId: { eventId: event.id, userId: session.user.id },
      },
    })

    if (existing && existing.leftAt === null) {
      return { success: true, alreadyJoined: true }
    }

    // If event hasn't started yet, add to waitlist
    if (event.startsAt && event.startsAt > now) {
      await prisma.eventWaitlist.upsert({
        where: { eventId_userId: { eventId: event.id, userId: session.user.id } },
        update: {},
        create: { eventId: event.id, userId: session.user.id },
      })
      return { success: true, waitlisted: true }
    }

    if (!data.force) {
      const currentEvent = await getCurrentActiveEvent(session.user.id)
      if (currentEvent && currentEvent.id !== event.id) {
        return { success: false, needsConfirm: true as const, currentEvent, eventName: event.name }
      }
    }

    // Capacity is checked inside the same transaction that writes the
    // attendee row, under a row lock on the event. Reading the count outside
    // the transaction let two concurrent joins both see the last free slot.
    const joined = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ maxAttendees: number | null }>>`
        SELECT "maxAttendees" FROM "Event" WHERE "id" = ${event.id} FOR UPDATE
      `
      const maxAttendees = locked[0]?.maxAttendees ?? null

      if (maxAttendees !== null) {
        const activeCount = await tx.eventAttendee.count({
          where: { eventId: event.id, leftAt: null },
        })
        if (activeCount >= maxAttendees) return false
      }

      await leaveAllActiveEvents(session.user.id, tx)

      await tx.eventAttendee.upsert({
        where: {
          eventId_userId: { eventId: event.id, userId: session.user.id },
        },
        update: { leftAt: null, removedById: null, removedAt: null },
        create: { eventId: event.id, userId: session.user.id },
      })

      // They're in; drop any waitlist entry for this event.
      await tx.eventWaitlist.deleteMany({
        where: { eventId: event.id, userId: session.user.id },
      })

      return true
    })

    if (!joined) {
      return { success: false, message: 'Event is full' }
    }

    // Award social_butterfly after 3 events in the last 30 days.
    //
    // NOTE: this filtered on `createdAt`, which EventAttendee does not have —
    // Prisma rejected the query at runtime *after* the join had committed, so
    // every join reported failure. TypeScript does not catch this: Prisma's
    // Subset<> helper only excess-checks the top level of the argument object,
    // so unknown keys nested inside `where` compile fine.
    try {
      const totalJoinedEvents = await prisma.eventAttendee.count({
        where: {
          userId: session.user.id,
          leftAt: null,
          joinedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        },
      })
      if (totalJoinedEvents >= 3) {
        await awardBadgeIfNotExists(session.user.id, 'social_butterfly')
      }
    } catch (err) {
      // Badge accounting must never fail the join itself.
      console.warn('[badges] social_butterfly check failed:', err)
    }

    return { success: true }
  })

export const leaveEvent = createServerFn({ method: 'POST' })
  .inputValidator(z.string())
  .handler(async ({ data: eventId }) => {
    const session = await requireSession()

    // updateMany, not update: leaving an event you were never in should be a
    // no-op, not a P2025 that surfaces as a 500.
    await prisma.eventAttendee.updateMany({
      where: { eventId, userId: session.user.id, leftAt: null },
      data: { leftAt: new Date() },
    })

    await prisma.eventWaitlist.deleteMany({
      where: { eventId, userId: session.user.id },
    })

    return { success: true }
  })

export const getMyCreatedEvents = createServerFn({ method: 'GET' })
  .handler(async () => {
    const session = await requireSession()

    return prisma.event.findMany({
      where: { createdById: session.user.id },
      include: {
        _count: { select: { attendees: { where: { leftAt: null } } } },
      },
    })
  })

export const updateEvent = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    eventId: z.string(),
    data: z.object({
      name: z.string().min(1).max(100).optional(),
      photo: z.string().optional().nullable(),
      description: z.string().max(500).optional(),
      location: z.string().max(200).optional(),
      maxAttendees: z.number().int().min(1).max(1000).optional(),
      startsAt: z.string().datetime().optional(),
      endedAt: z.string().datetime().optional(),
      isActive: z.boolean().optional(),
      isPublic: z.boolean().optional(),
      mysteryMode: z.boolean().optional(),
      sponsorName: z.string().max(200).optional().nullable(),
      sponsorLogo: z.string().url().max(1000).optional().nullable(),
      sponsorFrameUrl: z.string().url().max(1000).optional().nullable(),
    }),
  }))
  .handler(async ({ data }) => {
    const session = await requireSession()

    const event = await prisma.event.findUnique({
      where: { id: data.eventId },
    })

    if (!event) {
      throw new Error('Event not found')
    }

    if (event.createdById !== session.user.id) {
      throw new Error('Unauthorized')
    }

    return prisma.event.update({
      where: { id: data.eventId },
      data: {
        name: data.data.name,
        photo: data.data.photo,
        description: data.data.description,
        location: data.data.location,
        maxAttendees: data.data.maxAttendees,
        startsAt: data.data.startsAt ? new Date(data.data.startsAt) : undefined,
        endedAt: data.data.endedAt ? new Date(data.data.endedAt) : undefined,
        isActive: data.data.isActive,
        isPublic: data.data.isPublic,
        mysteryMode: data.data.mysteryMode,
        sponsorName: data.data.sponsorName,
        sponsorLogo: data.data.sponsorLogo,
        sponsorFrameUrl: data.data.sponsorFrameUrl,
      },
    })
  })

export const deleteEvent = createServerFn({ method: 'POST' })
  .inputValidator(z.string())
  .handler(async ({ data: eventId }) => {
    const session = await requireSession()

    const event = await prisma.event.findUnique({
      where: { id: eventId },
    })

    if (!event) {
      throw new Error('Event not found')
    }

    if (event.createdById !== session.user.id) {
      throw new Error('Unauthorized')
    }

    await prisma.event.delete({
      where: { id: eventId },
    })
  })

export const getMyActiveEvent = createServerFn({ method: 'GET' })
  .handler(async () => {
    const session = await requireSession()

    // Promote any waitlisted events that have started
    const waitlisted = await prisma.eventWaitlist.findMany({
      where: { userId: session.user.id },
      select: { eventId: true },
    })
    await Promise.all(waitlisted.map((w) => maybePromoteWaitlist(w.eventId)))

    const attendee = await prisma.eventAttendee.findFirst({
      where: { userId: session.user.id, leftAt: null },
      include: {
        event: {
          include: {
            _count: { select: { attendees: { where: { leftAt: null } } } },
          },
        },
      },
    })

    return attendee?.event ?? null
  })

const DECK_PROFILE_SELECT = {
  id: true,
  userId: true,
  name: true,
  bio: true,
  photos: true,
  gender: true,
  birthDate: true,
  location: true,
  interests: true,
  lookingFor: true,
  job: true,
  verifiedAt: true,
  boostedUntil: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: { name: true, image: true, email: true, lastActiveDate: true },
  },
} satisfies Prisma.ProfileSelect

export interface DeckProfile {
  id: string
  userId: string
  name: string
  bio: string | null
  photos: string[]
  gender: string | null
  birthDate: string | null
  location: string | null
  interests: string[]
  lookingFor: string[]
  job: string | null
  verifiedAt: Date | null
  boostedUntil: Date | null
  createdAt: Date
  updatedAt: Date
  isBoosted: boolean
  sharedInterests: string[]
  lastActiveDate: Date | null
}

export interface SwipeDeckPage {
  items: DeckProfile[]
  nextOffset: number | null
}

/**
 * Build one page of the swipe deck.
 *
 * Every exclusion that can be expressed in SQL now is: already-swiped, blocked
 * in either direction, disabled accounts, shadow-banned accounts, discovery
 * mode, gender preference and intent. The previous implementation pulled every
 * candidate profile in the database into memory and filtered with
 * `Array.includes` inside `.filter`, which is quadratic — a 50k pool against a
 * 10k swipe history was ~500M comparisons on the event loop, per request.
 *
 * Only the age filter stays in JS, because birthDate is stored as a free-form
 * string and cannot be compared reliably in SQL. It runs over at most
 * DECK_CANDIDATE_LIMIT rows.
 */
async function buildSwipeDeck({
  myUserId,
  candidateWhere,
  swipeHistoryEventId,
  intent,
  offset,
  limit,
}: {
  myUserId: string
  candidateWhere: Prisma.ProfileWhereInput
  swipeHistoryEventId: string | null
  intent?: 'dating' | 'friends' | 'networking'
  offset: number
  limit: number
}): Promise<SwipeDeckPage> {
  const [myProfile, flaggedIds] = await Promise.all([
    prisma.profile.findUnique({
      where: { userId: myUserId },
      select: { lookingFor: true, interests: true, prefAgeMin: true, prefAgeMax: true, prefShowMe: true },
    }),
    getFlaggedUserIds(),
  ])

  const prefAgeMin = myProfile?.prefAgeMin ?? 18
  const prefAgeMax = myProfile?.prefAgeMax ?? 99
  const prefShowMe = myProfile?.prefShowMe ?? 'Everyone'
  const myLookingFor = myProfile?.lookingFor ?? []
  const myInterests = new Set(myProfile?.interests ?? [])

  // AND-composed so the caller's `candidateWhere` (which may carry its own
  // `user` and `OR` clauses) can't be clobbered by the filters below.
  const where: Prisma.ProfileWhereInput = {
    AND: [
      candidateWhere,
      {
        userId: {
          not: myUserId,
          ...(flaggedIds.size > 0 ? { notIn: [...flaggedIds] } : {}),
        },
        user: {
          disabledAt: null,
          // Already swiped on, in this deck's scope.
          swipesReceived: { none: { swiperId: myUserId, eventId: swipeHistoryEventId } },
          // Candidate blocked me.
          blockedUsers: { none: { blockedId: myUserId } },
          // I blocked the candidate.
          blockingUsers: { none: { blockerId: myUserId } },
        },
      },
      ...(intent ? [{ lookingFor: { has: intent } }] : []),
      // Missing gender is never held against a candidate, matching the previous
      // behaviour — only exclude when we can positively tell they don't match.
      ...(prefShowMe !== 'Everyone'
        ? [
            {
              OR: [
                { gender: null },
                { gender: '' },
                { gender: prefShowMe === 'Women' ? 'Female' : 'Male' },
              ],
            },
          ]
        : []),
    ],
  }

  // Fetch exactly one page worth. The page IS this window: everything in it
  // that survives the age filter is returned, and nextOffset advances by the
  // window size, so no candidate is ever skipped.
  //
  // Over-fetching and slicing to `limit` was wrong — nextOffset advanced past
  // rows that had been fetched but never returned, hiding most of the pool.
  const fetchSize = Math.min(limit, DECK_CANDIDATE_LIMIT)

  const rows = await prisma.profile.findMany({
    where,
    select: DECK_PROFILE_SELECT,
    // Boosted profiles first, then most recently active. Stable ordering is
    // what makes offset paging safe.
    orderBy: [
      { boostedUntil: { sort: 'desc', nulls: 'last' } },
      { updatedAt: 'desc' },
      { id: 'asc' },
    ],
    skip: offset,
    take: fetchSize + 1,
  })

  const hasMore = rows.length > fetchSize
  const candidates = hasMore ? rows.slice(0, -1) : rows

  const now = new Date()

  // Age filter — the one predicate that cannot move into SQL.
  const eligible = candidates.filter((p) => {
    const age = calculateAge(p.birthDate)
    return age === null || (age >= prefAgeMin && age <= prefAgeMax)
  })

  const boostedIds = new Set(
    eligible.filter((p) => p.boostedUntil && p.boostedUntil > now).map((p) => p.userId),
  )

  const boosted = eligible.filter((p) => boostedIds.has(p.userId))
  const nonBoosted = eligible.filter((p) => !boostedIds.has(p.userId))

  // Vary the order between users and between pages, but keep it deterministic
  // so a refetch of the same page returns the same order.
  const seed = `${myUserId}:${offset}`
  const overlapScore = (lookingFor: string[]) =>
    myLookingFor.length === 0 ? 0 : lookingFor.filter((x) => myLookingFor.includes(x)).length

  const rank = (group: typeof eligible) =>
    seededShuffle(group, seed)
      // Stable sort keeps the shuffle intact within equal-overlap groups.
      .sort((a, b) => overlapScore(b.lookingFor) - overlapScore(a.lookingFor))

  // No slice: every eligible candidate in this window is returned. A page can
  // come back shorter than `limit` when the age filter removes people, which
  // is correct — the client keeps paging until nextOffset is null.
  const ordered = [...rank(boosted), ...rank(nonBoosted)]

  const items: DeckProfile[] = ordered.map(({ user, ...profile }) => ({
    ...profile,
    name: profile.name || user?.name || user?.email?.split('@')[0] || 'Unnamed',
    photos:
      profile.photos && profile.photos.length > 0
        ? profile.photos
        : user?.image
          ? [user.image]
          : [],
    isBoosted: boostedIds.has(profile.userId),
    sharedInterests: (profile.interests ?? []).filter((i) => myInterests.has(i)),
    lastActiveDate: user?.lastActiveDate ?? null,
  }))

  return {
    items,
    // Advance by rows consumed from the DB window, never more.
    nextOffset: hasMore ? offset + candidates.length : null,
  }
}

const deckInput = z.object({
  intent: z.enum(['dating', 'friends', 'networking']).optional(),
  offset: z.number().int().min(0).max(10_000).default(0),
  limit: z.number().int().min(1).max(50).default(DECK_PAGE_SIZE),
})

export const getEventProfiles = createServerFn({ method: 'GET' })
  .inputValidator(deckInput.extend({ eventId: z.string() }))
  .handler(async ({ data: { eventId, intent, offset, limit } }) => {
    const session = await requireSession()
    const myUserId = session.user.id

    await maybePromoteWaitlist(eventId)

    return buildSwipeDeck({
      myUserId,
      // Only attendees who've opted into event-scoped discovery show up here —
      // global-mode attendees are only discoverable in the global pool.
      candidateWhere: {
        discoveryMode: 'event',
        user: { attendances: { some: { eventId, leftAt: null } } },
      },
      swipeHistoryEventId: eventId,
      intent,
      offset,
      limit,
    })
  })

export const getGlobalProfiles = createServerFn({ method: 'GET' })
  .inputValidator(deckInput.optional())
  .handler(async ({ data }) => {
    const session = await requireSession()

    return buildSwipeDeck({
      myUserId: session.user.id,
      candidateWhere: { discoveryMode: 'global' },
      swipeHistoryEventId: null,
      intent: data?.intent,
      offset: data?.offset ?? 0,
      limit: data?.limit ?? DECK_PAGE_SIZE,
    })
  })

export const getEventAttendees = createServerFn({ method: 'GET' })
  .inputValidator(z.string())
  .handler(async ({ data: eventId }) => {
    const session = await requireSession()
    const myUserId = session.user.id

    await maybePromoteWaitlist(eventId)

    const rows = await prisma.eventAttendee.findMany({
      where: { eventId, leftAt: null },
      select: { userId: true },
    })
    const userIds = rows.map((r) => r.userId)

    if (userIds.length === 0) return []

    // Exclude blocked users (bidirectional)
    const blockedRelations = await prisma.userBlock.findMany({
      where: {
        OR: [
          { blockerId: myUserId, blockedId: { in: userIds } },
          { blockerId: { in: userIds }, blockedId: myUserId },
        ],
      },
      select: { blockerId: true, blockedId: true },
    })
    const blockedIds = new Set<string>()
    for (const b of blockedRelations) {
      blockedIds.add(b.blockerId === myUserId ? b.blockedId : b.blockerId)
    }
    const unblockedUserIds = userIds.filter((id) => !blockedIds.has(id))

    const [profiles, users] = await Promise.all([
      prisma.profile.findMany({
        where: { userId: { in: unblockedUserIds } },
      }),
      prisma.user.findMany({
        where: { id: { in: unblockedUserIds } },
        select: { id: true, name: true, image: true, email: true, disabledAt: true },
      }),
    ])

    const userById = new Map(users.map((u) => [u.id, u]))
    const profileByUserId = new Map(profiles.map((p) => [p.userId, p]))

    // Filter out disabled accounts and shadow-banned users (auto-moderation).
    // getFlaggedUserIds returns a Set — the old `.includes()` inside `.filter()`
    // was a linear scan per candidate.
    const flaggedIds = await getFlaggedUserIds()
    const activeUserIds = unblockedUserIds.filter(
      (id) => !userById.get(id)?.disabledAt && !flaggedIds.has(id),
    )

    return activeUserIds.map((userId): Profile => {
      const profile = profileByUserId.get(userId)
      if (profile) {
        // Verification captures are review material — never ship them to peers.
        return {
          ...profile,
          verificationPhoto: null,
          verificationSubmittedAt: null,
          verificationStatus: null,
        }
      }
      const user = userById.get(userId)
      return {
        id: user?.id ?? userId,
        userId,
        name: user?.name || user?.email?.split('@')[0] || 'Unnamed',
        bio: '',
        photos: user?.image ? [user.image] : [],
        gender: '',
        birthDate: '',
        location: '',
        interests: [],
        lookingFor: [],
        job: '',
        verifiedAt: null,
        verificationPhoto: null,
        verificationSubmittedAt: null,
        verificationStatus: null,
        boostedUntil: null,
        lastBoostedAt: null,
        discoveryMode: 'global',
        prefAgeMin: 18,
        prefAgeMax: 99,
        prefShowMe: 'Everyone',
        createdAt: new Date(),
        updatedAt: new Date(),
      }
    })
  })

export const removeEventAttendee = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ eventId: z.string(), userId: z.string() }))
  .handler(async ({ data }) => {
    const session = await requireSession()

    const event = await prisma.event.findUnique({ where: { id: data.eventId } })
    if (!event) throw new Error('Event not found')
    if (event.createdById !== session.user.id) throw new Error('Unauthorized')

    await prisma.eventAttendee.updateMany({
      where: { eventId: data.eventId, userId: data.userId, leftAt: null },
      data: { leftAt: new Date(), removedById: session.user.id, removedAt: new Date() },
    })

    return { success: true }
  })

export const blockEventAttendee = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ eventId: z.string(), userId: z.string(), reason: z.string().optional() }))
  .handler(async ({ data }) => {
    const session = await requireSession()

    const event = await prisma.event.findUnique({ where: { id: data.eventId } })
    if (!event) throw new Error('Event not found')
    if (event.createdById !== session.user.id) throw new Error('Unauthorized')

    await prisma.eventBlockedUser.upsert({
      where: { eventId_userId: { eventId: data.eventId, userId: data.userId } },
      update: { reason: data.reason ?? null, blockedById: session.user.id },
      create: {
        eventId: data.eventId,
        userId: data.userId,
        blockedById: session.user.id,
        reason: data.reason,
      },
    })

    // Also remove them from attendees if they are still in
    await prisma.eventAttendee.updateMany({
      where: { eventId: data.eventId, userId: data.userId, leftAt: null },
      data: { leftAt: new Date(), removedById: session.user.id, removedAt: new Date() },
    })

    return { success: true }
  })

export const unblockEventAttendee = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ eventId: z.string(), userId: z.string() }))
  .handler(async ({ data }) => {
    const session = await requireSession()

    const event = await prisma.event.findUnique({ where: { id: data.eventId } })
    if (!event) throw new Error('Event not found')
    if (event.createdById !== session.user.id) throw new Error('Unauthorized')

    await prisma.eventBlockedUser.deleteMany({
      where: { eventId: data.eventId, userId: data.userId },
    })

    return { success: true }
  })

export const getEventBlockedUsers = createServerFn({ method: 'GET' })
  .inputValidator(z.string())
  .handler(async ({ data: eventId }) => {
    const session = await requireSession()

    const event = await prisma.event.findUnique({ where: { id: eventId } })
    if (!event) throw new Error('Event not found')
    if (event.createdById !== session.user.id) throw new Error('Unauthorized')

    const blocked = await prisma.eventBlockedUser.findMany({
      where: { eventId },
      select: { userId: true, reason: true, blockedAt: true },
    })

    const userIds = blocked.map((b) => b.userId)
    if (userIds.length === 0) return []

    const [profiles, users] = await Promise.all([
      prisma.profile.findMany({ where: { userId: { in: userIds } } }),
      prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, disabledAt: true },
      }),
    ])

    const userById = new Map(users.map((u) => [u.id, u]))
    const profileByUserId = new Map(profiles.map((p) => [p.userId, p]))

    return blocked
      .filter((b) => !userById.get(b.userId)?.disabledAt)
      .map((b) => {
        const profile = profileByUserId.get(b.userId)
        return { ...b, profile }
      })
  })

export const getMyWaitlistedEvents = createServerFn({ method: 'GET' })
  .handler(async () => {
    const session = await requireSession()

    const rows = await prisma.eventWaitlist.findMany({
      where: { userId: session.user.id },
      include: {
        event: {
          include: {
            _count: { select: { attendees: { where: { leftAt: null } } } },
          },
        },
      },
    })

    // Promote waitlists in case any events have started
    await Promise.all(rows.map((r) => maybePromoteWaitlist(r.eventId)))

    // Re-fetch after promotion so we only return events where user is still waitlisted
    const refreshed = await prisma.eventWaitlist.findMany({
      where: { userId: session.user.id },
      include: {
        event: {
          include: {
            _count: { select: { attendees: { where: { leftAt: null } } } },
          },
        },
      },
    })

    return refreshed.map((r) => r.event)
  })

export const getEventWaitlist = createServerFn({ method: 'GET' })
  .inputValidator(z.string())
  .handler(async ({ data: eventId }) => {
    const session = await requireSession()

    const event = await prisma.event.findUnique({ where: { id: eventId } })
    if (!event) throw new Error('Event not found')

    const isCreator = event.createdById === session.user.id
    const isWaitlisted = await prisma.eventWaitlist.findUnique({
      where: { eventId_userId: { eventId, userId: session.user.id } },
    })

    if (!isCreator && !isWaitlisted) {
      throw new Error('Unauthorized')
    }

    await maybePromoteWaitlist(eventId)

    const rows = await prisma.eventWaitlist.findMany({
      where: { eventId },
      orderBy: { joinedAt: 'asc' },
      select: { userId: true, joinedAt: true },
    })

    if (rows.length === 0) return []

    const userIds = rows.map((r) => r.userId)
    const [profiles, users] = await Promise.all([
      prisma.profile.findMany({ where: { userId: { in: userIds } } }),
      prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, image: true, email: true, disabledAt: true },
      }),
    ])

    const userById = new Map(users.map((u) => [u.id, u]))
    const profileByUserId = new Map(profiles.map((p) => [p.userId, p]))

    // Map lookup instead of rows.find() inside the map — that was a linear
    // scan per entry.
    const rowByUserId = new Map(rows.map((r) => [r.userId, r]))
    const activeUserIds = userIds.filter((id) => !userById.get(id)?.disabledAt)

    return activeUserIds.map((userId) => {
      const profile = profileByUserId.get(userId)
      const user = userById.get(userId)
      const row = rowByUserId.get(userId)!
      return {
        userId,
        joinedAt: row.joinedAt,
        name: profile?.name || user?.name || user?.email?.split('@')[0] || 'Unnamed',
        photo: profile?.photos?.[0] || user?.image || null,
      }
    })
  })

export const removeFromWaitlist = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ eventId: z.string(), userId: z.string().optional() }))
  .handler(async ({ data }) => {
    const session = await requireSession()
    const targetUserId = data.userId || session.user.id

    if (targetUserId !== session.user.id) {
      const event = await prisma.event.findUnique({ where: { id: data.eventId } })
      if (!event) throw new Error('Event not found')
      if (event.createdById !== session.user.id) throw new Error('Unauthorized')
    }

    await prisma.eventWaitlist.deleteMany({
      where: { eventId: data.eventId, userId: targetUserId },
    })

    return { success: true }
  })

export const reportUser = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    eventId: z.string().optional(),
    reportedId: z.string(),
    reason: z.string().min(1).max(1000),
  }))
  .handler(async ({ data }) => {
    const session = await requireSession()
    const reporterId = session.user.id

    if (reporterId === data.reportedId) {
      return { success: false as const, message: 'You cannot report yourself' }
    }

    const throttle = await reportRateLimit(`report:${reporterId}`)
    if (!throttle.success) {
      return { success: false as const, message: 'You have filed too many reports recently.' }
    }

    if (data.eventId) {
      const eventId = data.eventId
      // Both users should be attending the event
      const [reporterAttendee, reportedAttendee] = await Promise.all([
        prisma.eventAttendee.findFirst({
          where: { eventId, userId: reporterId, leftAt: null },
          select: { id: true },
        }),
        prisma.eventAttendee.findFirst({
          where: { eventId, userId: data.reportedId, leftAt: null },
          select: { id: true },
        }),
      ])

      if (!reporterAttendee) {
        return { success: false as const, message: 'You must be attending the event to report someone' }
      }
      if (!reportedAttendee) {
        return { success: false as const, message: 'Reported user is not attending this event' }
      }
    } else {
      // A global report requires that the two users have actually crossed
      // paths. Without this, anyone could report anyone — and since reports
      // feed auto-moderation, that was a way to hide arbitrary users.
      const [sharedEvent, match, swipe] = await Promise.all([
        prisma.eventAttendee.findFirst({
          where: {
            userId: reporterId,
            event: { attendees: { some: { userId: data.reportedId } } },
          },
          select: { id: true },
        }),
        prisma.eventMatch.findFirst({
          where: {
            OR: [
              { user1Id: reporterId, user2Id: data.reportedId },
              { user1Id: data.reportedId, user2Id: reporterId },
            ],
          },
          select: { id: true },
        }),
        prisma.eventSwipe.findFirst({
          where: {
            OR: [
              { swiperId: reporterId, swipedId: data.reportedId },
              { swiperId: data.reportedId, swipedId: reporterId },
            ],
          },
          select: { id: true },
        }),
      ])

      if (!sharedEvent && !match && !swipe) {
        return { success: false as const, message: 'You can only report people you have encountered' }
      }
    }

    // Update in place rather than stacking rows: a repeat report from the same
    // reporter must not inflate the count that auto-moderation reads. The
    // unique indexes on (reporterId, reportedId, eventId) — plus the partial
    // one for global reports — backstop the race between the read and write
    // below. Prisma's compound-unique upsert can't express a NULL eventId, so
    // this is find-then-write with a P2002 catch.
    const eventId = data.eventId ?? null
    const reason = sanitizeText(data.reason)

    const existing = await prisma.report.findFirst({
      where: { reporterId, reportedId: data.reportedId, eventId },
      select: { id: true },
    })

    if (existing) {
      await prisma.report.update({
        where: { id: existing.id },
        data: { reason, status: 'pending', createdAt: new Date() },
      })
    } else {
      try {
        await prisma.report.create({
          data: { eventId, reporterId, reportedId: data.reportedId, reason },
        })
      } catch (err) {
        // Lost the race with a concurrent identical report — that's the
        // desired end state anyway.
        if (
          !(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        ) {
          throw err
        }
      }
    }

    return { success: true as const }
  })

export const getEventReports = createServerFn({ method: 'GET' })
  .inputValidator(z.string())
  .handler(async ({ data: eventId }) => {
    const session = await requireSession()

    const event = await prisma.event.findUnique({ where: { id: eventId } })
    if (!event) throw new Error('Event not found')
    if (event.createdById !== session.user.id) throw new Error('Unauthorized')

    const reports = await prisma.report.findMany({
      where: { eventId },
      orderBy: { createdAt: 'desc' },
    })

    const userIds = [...new Set(reports.flatMap((r) => [r.reporterId, r.reportedId]))]
    const [profiles, users] = await Promise.all([
      prisma.profile.findMany({ where: { userId: { in: userIds } } }),
      prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, disabledAt: true },
      }),
    ])

    const userById = new Map(users.map((u) => [u.id, u]))
    const profileByUserId = new Map(profiles.map((p) => [p.userId, p]))

    const activeUserIds = new Set(
      userIds.filter((id) => !userById.get(id)?.disabledAt)
    )

    return reports
      .filter((r) => activeUserIds.has(r.reporterId) && activeUserIds.has(r.reportedId))
      .map((r) => ({
        ...r,
        reporter: profileByUserId.get(r.reporterId),
        reported: profileByUserId.get(r.reportedId),
      }))
  })

export const getEventPosts = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ 
    eventId: z.string(),
    cursor: z.string().optional(),
    limit: z.number().min(1).max(50).default(20),
  }))
  .handler(async ({ data: { eventId, cursor, limit } }) => {
    const session = await requireSession()

    const event = await prisma.event.findUnique({ where: { id: eventId } })
    if (!event) throw new Error('Event not found')

    const isCreator = event.createdById === session.user.id
    const isAttendee = await prisma.eventAttendee.findFirst({
      where: { eventId, userId: session.user.id, leftAt: null },
    })

    if (!isCreator && !isAttendee) {
      throw new Error('Unauthorized')
    }

    const posts = await prisma.eventPost.findMany({
      where: { eventId },
      // id as a tiebreaker: cursor pagination on a non-unique ordering
      // key can skip or repeat rows when timestamps collide.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    })

    const hasMore = posts.length > limit
    const items = hasMore ? posts.slice(0, limit) : posts

    const userIds = [...new Set(items.map((p) => p.userId))]
    const [profiles, users] = await Promise.all([
      prisma.profile.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, name: true, photos: true },
      }),
      prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, image: true },
      }),
    ])

    const profileByUserId = new Map(profiles.map((p) => [p.userId, p]))
    const userById = new Map(users.map((u) => [u.id, u]))

    return {
      items: items.map((post) => {
        const profile = profileByUserId.get(post.userId)
        const user = userById.get(post.userId)
        return {
          ...post,
          author: {
            name: profile?.name || user?.name || 'Unnamed',
            photo: profile?.photos?.[0] || user?.image || null,
          },
        }
      }),
      nextCursor: hasMore ? items[items.length - 1].id : null,
    }
  })

export const createEventPost = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ eventId: z.string(), content: z.string().min(1).max(1000) }))
  .handler(async ({ data: { eventId, content } }) => {
    const session = await requireSession()

    const event = await prisma.event.findUnique({ where: { id: eventId } })
    if (!event) throw new Error('Event not found')

    const isCreator = event.createdById === session.user.id
    const isAttendee = await prisma.eventAttendee.findFirst({
      where: { eventId, userId: session.user.id, leftAt: null },
      select: { id: true },
    })

    if (!isCreator && !isAttendee) {
      throw new Error('Unauthorized')
    }

    const throttle = await eventPostRateLimit(`event-post:${session.user.id}`)
    if (!throttle.success) {
      throw new Error('You are posting too quickly. Please slow down.')
    }

    const post = await prisma.eventPost.create({
      data: {
        eventId,
        userId: session.user.id,
        content: sanitizeText(content.trim()),
      },
    })

    const [profile, user] = await Promise.all([
      prisma.profile.findUnique({
        where: { userId: session.user.id },
        select: { name: true, photos: true },
      }),
      prisma.user.findUnique({
        where: { id: session.user.id },
        select: { name: true, image: true },
      }),
    ])

    const postWithAuthor = {
      ...post,
      author: {
        name: profile?.name || user?.name || 'Unnamed',
        photo: profile?.photos?.[0] || user?.image || null,
      },
    }

    broadcastToEvent(eventId, {
      type: 'event_post',
      payload: { eventId, post: postWithAuthor },
      timestamp: Date.now(),
    })

    return postWithAuthor
  })
