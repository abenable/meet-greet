import { createServerFn } from '@tanstack/react-start'
import { prisma } from '#/db'
import { requireSession } from '#/server/auth'

// A user is considered "active now" if they've pinged within this window.
export const ONLINE_THRESHOLD_MS = 5 * 60 * 1000

/**
 * Don't rewrite the timestamp if it's already fresh. Presence only needs
 * minute-scale resolution, so collapsing writes here turns a per-tab,
 * per-interval write into roughly one write per user per interval — and drops
 * the write entirely for users with several tabs open.
 */
const PRESENCE_WRITE_INTERVAL_MS = 2 * 60 * 1000

export const pingPresence = createServerFn({ method: 'POST' })
  .handler(async () => {
    const session = await requireSession()

    // updateMany with a staleness predicate makes this a single conditional
    // statement — no read-then-write race, and no write at all in the common
    // case where another tab just pinged.
    await prisma.user.updateMany({
      where: {
        id: session.user.id,
        OR: [
          { lastActiveDate: null },
          { lastActiveDate: { lt: new Date(Date.now() - PRESENCE_WRITE_INTERVAL_MS) } },
        ],
      },
      data: { lastActiveDate: new Date() },
    })

    return { success: true }
  })
