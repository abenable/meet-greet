import { createServerFn } from '@tanstack/react-start'
import { prisma } from '#/db'
import { requireSession } from '#/server/auth'
import { awardBadgeIfNotExists } from './badges.server'

function startOfDay(d: Date): Date {
  const result = new Date(d)
  result.setHours(0, 0, 0, 0)
  return result
}

export const checkAndUpdateStreak = createServerFn({ method: 'POST' })
  .handler(async () => {
    const session = await requireSession()
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      // lastStreakDate, not lastActiveDate: the presence heartbeat owns
      // lastActiveDate and used to overwrite it with now() from an adjacent
      // effect, which made this calculation see a zero-day delta and bail.
      select: { streakCount: true, lastStreakDate: true },
    })
    if (!user) throw new Error('User not found')

    const now = new Date()
    const today = startOfDay(now)
    const lastStreak = user.lastStreakDate ? startOfDay(user.lastStreakDate) : null

    let streakCount = user.streakCount
    let increased = false

    if (!lastStreak) {
      streakCount = 1
      increased = true
    } else {
      const diffMs = today.getTime() - lastStreak.getTime()
      const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24))
      if (diffDays === 0) {
        return { streakCount, increased: false }
      } else if (diffDays === 1) {
        streakCount += 1
        increased = true
      } else {
        streakCount = 1
        increased = true
      }
    }

    // Guard on the value we just read so two tabs racing can't double-count.
    const updated = await prisma.user.updateMany({
      where: {
        id: session.user.id,
        lastStreakDate: user.lastStreakDate,
      },
      data: { streakCount, lastStreakDate: now },
    })
    if (updated.count === 0) {
      return { streakCount: user.streakCount, increased: false }
    }

    if (streakCount === 3) {
      await awardBadgeIfNotExists(session.user.id, 'streak_3')
    }
    if (streakCount === 7) {
      await awardBadgeIfNotExists(session.user.id, 'streak_7')
    }

    return { streakCount, increased }
  })

export const getUserBadges = createServerFn({ method: 'GET' })
  .handler(async () => {
    const session = await requireSession()
    return prisma.userBadge.findMany({
      where: { userId: session.user.id },
      orderBy: { earnedAt: 'desc' },
    })
  })

export const getUserStreak = createServerFn({ method: 'GET' })
  .handler(async () => {
    const session = await requireSession()
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { streakCount: true },
    })
    return { streakCount: user?.streakCount ?? 0 }
  })
