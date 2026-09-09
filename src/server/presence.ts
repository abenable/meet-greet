import { createServerFn } from '@tanstack/react-start'
import { prisma } from '#/db'
import { requireSession } from '#/server/auth'

// A user is considered "active now" if they've pinged within this window.
export const ONLINE_THRESHOLD_MS = 5 * 60 * 1000

export const pingPresence = createServerFn({ method: 'POST' })
  .handler(async () => {
    const session = await requireSession()
    await prisma.user.update({
      where: { id: session.user.id },
      data: { lastActiveDate: new Date() },
    })
    return { success: true }
  })
