import { describe, expect, it } from 'vitest'
import { PrismaClient, Prisma } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

/**
 * Prisma validates arguments client-side, before it opens a connection, so
 * these run without a database.
 *
 * They exist because TypeScript does NOT catch a bad `where` clause: Prisma's
 * `Subset<>` helper only excess-checks the top level of the argument object, so
 * unknown keys nested inside `where` compile cleanly and throw at runtime. That
 * is how `EventAttendee.createdAt` — a field that does not exist — shipped, and
 * made every event join report failure after the row had already been written.
 */
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: 'postgresql://u:p@127.0.0.1:1/none' }),
})

/** Resolves true if Prisma accepted the arguments (i.e. it got as far as connecting). */
async function argumentsAreValid(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run()
    return true
  } catch (err) {
    return !(err instanceof Prisma.PrismaClientValidationError)
  }
}

describe('EventAttendee queries', () => {
  it('rejects createdAt, which the model does not have', async () => {
    // Note there is no @ts-expect-error here: `tsc` accepts this line. That is
    // the whole reason this test exists — the compiler cannot see unknown keys
    // nested inside `where`, so only a runtime assertion catches them.
    const valid = await argumentsAreValid(() =>
      prisma.eventAttendee.count({ where: { userId: 'u', createdAt: { gte: new Date() } } }),
    )
    expect(valid).toBe(false)
  })

  it('accepts joinedAt, the field joinEvent should filter on', async () => {
    const valid = await argumentsAreValid(() =>
      prisma.eventAttendee.count({
        where: { userId: 'u', leftAt: null, joinedAt: { gte: new Date() } },
      }),
    )
    expect(valid).toBe(true)
  })
})

describe('swipe deck candidate query', () => {
  it('accepts the block/swipe exclusion filters used by buildSwipeDeck', async () => {
    const valid = await argumentsAreValid(() =>
      prisma.profile.findMany({
        where: {
          AND: [
            { discoveryMode: 'global' },
            {
              userId: { not: 'me', notIn: ['flagged'] },
              user: {
                disabledAt: null,
                swipesReceived: { none: { swiperId: 'me', eventId: null } },
                blockedUsers: { none: { blockedId: 'me' } },
                blockingUsers: { none: { blockerId: 'me' } },
              },
            },
            { lookingFor: { has: 'dating' } },
          ],
        },
        orderBy: [
          { boostedUntil: { sort: 'desc', nulls: 'last' } },
          { updatedAt: 'desc' },
          { id: 'asc' },
        ],
        take: 31,
        skip: 0,
      }),
    )
    expect(valid).toBe(true)
  })

  it('accepts the event-scoped attendee filter', async () => {
    const valid = await argumentsAreValid(() =>
      prisma.profile.findMany({
        where: {
          AND: [
            {
              discoveryMode: 'event',
              user: { attendances: { some: { eventId: 'e1', leftAt: null } } },
            },
          ],
        },
      }),
    )
    expect(valid).toBe(true)
  })
})

describe('verification review queue', () => {
  it('accepts the pending-verification query', async () => {
    const valid = await argumentsAreValid(() =>
      prisma.profile.findMany({
        where: { verificationStatus: 'pending' },
        orderBy: { verificationSubmittedAt: 'asc' },
        select: { userId: true, verificationPhoto: true, verificationSubmittedAt: true },
      }),
    )
    expect(valid).toBe(true)
  })
})

describe('streak bookkeeping', () => {
  it('uses lastStreakDate, not the presence heartbeat column', async () => {
    const valid = await argumentsAreValid(() =>
      prisma.user.updateMany({
        where: { id: 'u', lastStreakDate: null },
        data: { streakCount: 2, lastStreakDate: new Date() },
      }),
    )
    expect(valid).toBe(true)
  })
})

describe('presence heartbeat', () => {
  it('only writes when the stored timestamp is already stale', async () => {
    const valid = await argumentsAreValid(() =>
      prisma.user.updateMany({
        where: {
          id: 'u',
          OR: [{ lastActiveDate: null }, { lastActiveDate: { lt: new Date() } }],
        },
        data: { lastActiveDate: new Date() },
      }),
    )
    expect(valid).toBe(true)
  })
})
