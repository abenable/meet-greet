import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { prisma } from '#/db'
import { requireSession } from '#/server/auth'

export const updateEventSponsor = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    eventId: z.string(),
    sponsorName: z.string().max(200).optional(),
    sponsorLogo: z.string().url().max(1000).optional().nullable(),
    sponsorFrameUrl: z.string().url().max(1000).optional().nullable(),
  }))
  .handler(async ({ data }) => {
    const session = await requireSession()

    const event = await prisma.event.findUnique({
      where: { id: data.eventId },
    })
    if (!event) throw new Error('Event not found')
    if (event.createdById !== session.user.id) throw new Error('Unauthorized')

    return prisma.event.update({
      where: { id: data.eventId },
      data: {
        sponsorName: data.sponsorName,
        sponsorLogo: data.sponsorLogo,
        sponsorFrameUrl: data.sponsorFrameUrl,
      },
    })
  })

export const getEventSponsor = createServerFn({ method: 'GET' })
  .inputValidator(z.string())
  .handler(async ({ data: eventId }) => {
    await requireSession()

    const event = await prisma.event.findUnique({
      where: { id: eventId },
      select: { sponsorName: true, sponsorLogo: true, sponsorFrameUrl: true },
    })
    if (!event) return null
    return {
      sponsorName: event.sponsorName,
      sponsorLogo: event.sponsorLogo,
      sponsorFrameUrl: event.sponsorFrameUrl,
    }
  })

export const removeEventSponsor = createServerFn({ method: 'POST' })
  .inputValidator(z.string())
  .handler(async ({ data: eventId }) => {
    const session = await requireSession()

    const event = await prisma.event.findUnique({
      where: { id: eventId },
    })
    if (!event) throw new Error('Event not found')
    if (event.createdById !== session.user.id) throw new Error('Unauthorized')

    return prisma.event.update({
      where: { id: eventId },
      data: {
        sponsorName: null,
        sponsorLogo: null,
        sponsorFrameUrl: null,
      },
    })
  })
