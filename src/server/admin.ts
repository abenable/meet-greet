import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { prisma } from '#/db'
import { requireAdmin } from '#/server/auth'
import { createNotification } from './notifications.server'

export const getAdminStats = createServerFn({ method: 'GET' })
  .handler(async () => {
    await requireAdmin()

    const [
      totalUsers,
      totalEvents,
      activeEvents,
      totalMatches,
      totalMessages,
      totalReports,
      pendingReports,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.event.count(),
      prisma.event.count({ where: { isActive: true, endedAt: null } }),
      prisma.eventMatch.count(),
      prisma.eventMessage.count(),
      prisma.report.count(),
      // Actually pending, not "created in the last week" — the old filter
      // counted dismissed and reviewed reports and missed older open ones.
      prisma.report.count({ where: { status: 'pending' } }),
    ])

    const recentUsers = await prisma.user.count({
      where: { createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
    })

    return {
      totalUsers,
      totalEvents,
      activeEvents,
      totalMatches,
      totalMessages,
      totalReports,
      pendingReports,
      recentUsers,
    }
  })

export const getAllUsers = createServerFn({ method: 'GET' })
  .inputValidator(z.object({
    cursor: z.string().optional(),
    limit: z.number().min(1).max(100).default(50),
    search: z.string().optional(),
  }).optional())
  .handler(async ({ data }) => {
    await requireAdmin()

    const limit = data?.limit || 50
    const cursor = data?.cursor
    const search = data?.search

    const where = search
      ? {
          OR: [
            { email: { contains: search, mode: 'insensitive' as const } },
            { name: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : undefined

    const users = await prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        role: true,
        disabledAt: true,
        createdAt: true,
        _count: {
          select: {
            sessions: true,
          },
        },
      },
      // id as a tiebreaker: cursor pagination on a non-unique ordering
      // key can skip or repeat rows when timestamps collide.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    })

    const hasMore = users.length > limit
    const items = hasMore ? users.slice(0, limit) : users

    return {
      items,
      nextCursor: hasMore ? items[items.length - 1].id : null,
    }
  })

export const updateUserRole = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    userId: z.string(),
    role: z.enum(['user', 'admin']),
  }))
  .handler(async ({ data }) => {
    const session = await requireAdmin()

    if (data.role !== 'admin') {
      // Don't let an admin demote themselves by accident, and never leave the
      // instance with zero admins — both states can only be undone by direct
      // database access.
      if (data.userId === session.user.id) {
        throw new Error('You cannot remove your own admin access')
      }
      const remainingAdmins = await prisma.user.count({
        where: { role: 'admin', id: { not: data.userId }, disabledAt: null },
      })
      if (remainingAdmins === 0) {
        throw new Error('Cannot remove the last remaining admin')
      }
    }

    await prisma.user.update({
      where: { id: data.userId },
      data: { role: data.role },
    })

    console.info(
      `[admin] ${session.user.id} set role="${data.role}" on user ${data.userId}`,
    )

    return { success: true }
  })

export const toggleUserDisabled = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    userId: z.string(),
    disabled: z.boolean(),
  }))
  .handler(async ({ data }) => {
    await requireAdmin()

    await prisma.user.update({
      where: { id: data.userId },
      data: {
        disabledAt: data.disabled ? new Date() : null,
      },
    })

    if (data.disabled) {
      await prisma.session.deleteMany({
        where: { userId: data.userId },
      })
      await prisma.eventAttendee.updateMany({
        where: { userId: data.userId, leftAt: null },
        data: { leftAt: new Date() },
      })
    }

    return { success: true }
  })

export const getAllEvents = createServerFn({ method: 'GET' })
  .inputValidator(z.object({
    cursor: z.string().optional(),
    limit: z.number().min(1).max(100).default(50),
  }).optional())
  .handler(async ({ data }) => {
    await requireAdmin()

    const limit = data?.limit || 50
    const cursor = data?.cursor

    const events = await prisma.event.findMany({
      select: {
        id: true,
        name: true,
        code: true,
        photo: true,
        location: true,
        isActive: true,
        isPublic: true,
        createdAt: true,
        startsAt: true,
        endedAt: true,
        createdById: true,
        maxAttendees: true,
        _count: {
          select: {
            attendees: { where: { leftAt: null } },
            swipes: true,
            matches: true,
            waitlist: true,
          },
        },
      },
      // id as a tiebreaker: cursor pagination on a non-unique ordering
      // key can skip or repeat rows when timestamps collide.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    })

    const hasMore = events.length > limit
    const items = hasMore ? events.slice(0, limit) : events

    return {
      items,
      nextCursor: hasMore ? items[items.length - 1].id : null,
    }
  })

export const adminDeleteEvent = createServerFn({ method: 'POST' })
  .inputValidator(z.string())
  .handler(async ({ data: eventId }) => {
    await requireAdmin()

    // Deliberately no R2 cleanup here. Since the global-discovery migration,
    // EventMatch.eventId is ON DELETE SET NULL — matches and their messages
    // outlive the event they were made at. The previous implementation deleted
    // the audio for every match that had ever belonged to this event, which
    // silently broke voice messages in conversations that were still active.
    //
    // Voice files therefore stay in R2, which is correct: the conversations
    // that reference them are still live.
    //
    // Nothing in the app deletes a match today, so nothing orphans those
    // objects. deleteVoiceFilesForMatches() in matches.server.ts exists for the
    // paths that will orphan them — account deletion, or any future match
    // cleanup — and has no caller yet.
    await prisma.event.delete({
      where: { id: eventId },
    })

    return { success: true }
  })

export const adminToggleEventActive = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    eventId: z.string(),
    active: z.boolean(),
  }))
  .handler(async ({ data }) => {
    await requireAdmin()

    await prisma.event.update({
      where: { id: data.eventId },
      data: { isActive: data.active },
    })

    return { success: true }
  })

export const getAllReports = createServerFn({ method: 'GET' })
  .inputValidator(z.object({
    cursor: z.string().optional(),
    limit: z.number().min(1).max(100).default(50),
    status: z.string().optional(),
  }).optional())
  .handler(async ({ data }) => {
    await requireAdmin()

    const limit = data?.limit || 50
    const cursor = data?.cursor
    const where = data?.status ? { status: data.status } : undefined

    const reports = await prisma.report.findMany({
      where,
      // id as a tiebreaker: cursor pagination on a non-unique ordering
      // key can skip or repeat rows when timestamps collide.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    })

    const userIds = [...new Set(reports.flatMap((r) => [r.reporterId, r.reportedId]))]

    const [profiles, users] = await Promise.all([
      prisma.profile.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, name: true, photos: true },
      }),
      prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, email: true, image: true, disabledAt: true },
      }),
    ])

    const userById = new Map(users.map((u) => [u.id, u]))
    const profileByUserId = new Map(profiles.map((p) => [p.userId, p]))

    const hasMore = reports.length > limit
    const items = hasMore ? reports.slice(0, limit) : reports

    return {
      items: items.map((r) => ({
        ...r,
        reporter: {
          ...userById.get(r.reporterId),
          profile: profileByUserId.get(r.reporterId),
        },
        reported: {
          ...userById.get(r.reportedId),
          profile: profileByUserId.get(r.reportedId),
        },
      })),
      nextCursor: hasMore ? items[items.length - 1].id : null,
    }
  })

export const deleteReport = createServerFn({ method: 'POST' })
  .inputValidator(z.string())
  .handler(async ({ data: reportId }) => {
    await requireAdmin()

    await prisma.report.delete({
      where: { id: reportId },
    })

    return { success: true }
  })

export const getEventsWithSponsors = createServerFn({ method: 'GET' })
  .handler(async () => {
    await requireAdmin()

    const events = await prisma.event.findMany({
      where: {
        OR: [
          { sponsorName: { not: null } },
          { sponsorLogo: { not: null } },
          { sponsorFrameUrl: { not: null } },
        ],
      },
      select: {
        id: true,
        name: true,
        code: true,
        photo: true,
        location: true,
        sponsorName: true,
        sponsorLogo: true,
        sponsorFrameUrl: true,
        createdById: true,
        createdAt: true,
        _count: {
          select: {
            attendees: { where: { leftAt: null } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    const userIds = [...new Set(events.map((e) => e.createdById))]
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, email: true },
    })
    const userById = new Map(users.map((u) => [u.id, u]))

    return events.map((event) => ({
      ...event,
      creator: userById.get(event.createdById) ?? null,
    }))
  })

export const getFlaggedUsers = createServerFn({ method: 'GET' })
  .handler(async () => {
    await requireAdmin()

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)

    const flagged = await prisma.report.groupBy({
      by: ['reportedId'],
      where: {
        status: 'pending',
        createdAt: { gte: twentyFourHoursAgo },
      },
      _count: {
        id: true,
      },
      having: {
        id: {
          _count: {
            gte: 2,
          },
        },
      },
    })

    const userIds = flagged.map((f) => f.reportedId)
    if (userIds.length === 0) return []

    const [users, latestReports] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: userIds } },
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          disabledAt: true,
        },
      }),
      prisma.report.findMany({
        where: {
          reportedId: { in: userIds },
          status: 'pending',
          createdAt: { gte: twentyFourHoursAgo },
        },
        orderBy: { createdAt: 'desc' },
        distinct: ['reportedId'],
        select: {
          reportedId: true,
          reason: true,
          createdAt: true,
        },
      }),
    ])

    const reportCountByUser = new Map(flagged.map((f) => [f.reportedId, f._count.id]))
    const latestReportByUser = new Map(latestReports.map((r) => [r.reportedId, r]))

    return users.map((user) => ({
      ...user,
      reportCount: reportCountByUser.get(user.id) ?? 0,
      latestReason: latestReportByUser.get(user.id)?.reason ?? '',
    }))
  })

export const dismissReport = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    reportId: z.string(),
  }))
  .handler(async ({ data }) => {
    await requireAdmin()

    await prisma.report.update({
      where: { id: data.reportId },
      data: { status: 'dismissed' },
    })

    return { success: true }
  })

export const reviewReport = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    reportId: z.string(),
  }))
  .handler(async ({ data }) => {
    await requireAdmin()

    await prisma.report.update({
      where: { id: data.reportId },
      data: { status: 'reviewed' },
    })

    return { success: true }
  })

export const getPendingVerifications = createServerFn({ method: 'GET' })
  .inputValidator(z.object({
    limit: z.number().min(1).max(100).default(50),
  }).optional())
  .handler(async ({ data }) => {
    await requireAdmin()

    const profiles = await prisma.profile.findMany({
      where: { verificationStatus: 'pending' },
      orderBy: { verificationSubmittedAt: 'asc' },
      take: data?.limit ?? 50,
      select: {
        userId: true,
        name: true,
        photos: true,
        verificationPhoto: true,
        verificationSubmittedAt: true,
      },
    })

    return profiles
  })

/**
 * The only place verifiedAt is ever written. Users submit through
 * submitPhotoVerification(); the badge itself is an admin decision.
 */
export const reviewVerification = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    userId: z.string(),
    approve: z.boolean(),
  }))
  .handler(async ({ data }) => {
    await requireAdmin()

    await prisma.profile.update({
      where: { userId: data.userId },
      data: data.approve
        ? { verifiedAt: new Date(), verificationStatus: 'approved' }
        : { verifiedAt: null, verificationStatus: 'rejected' },
    })

    await createNotification({
      userId: data.userId,
      type: 'request_accepted',
      title: data.approve ? 'Profile verified' : 'Verification not approved',
      body: data.approve
        ? 'Your verified badge is now live on your profile.'
        : 'We could not verify your photo. You can submit a new one from your profile.',
      link: '/profile',
    }).catch(() => {})

    return { success: true }
  })

export const dismissAllReportsForUser = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    userId: z.string(),
  }))
  .handler(async ({ data }) => {
    await requireAdmin()

    await prisma.report.updateMany({
      where: { reportedId: data.userId, status: 'pending' },
      data: { status: 'dismissed' },
    })

    return { success: true }
  })
