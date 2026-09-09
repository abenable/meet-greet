import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { prisma } from '#/db'
import { requireSession } from '#/server/auth'
import { sanitizeProfile } from '#/lib/sanitize'
import { r2Client, R2_BUCKET_NAME } from '#/lib/r2'
import { PutObjectCommand } from '@aws-sdk/client-s3'

export const getMyProfile = createServerFn({ method: 'GET' })
  .handler(async () => {
    const session = await requireSession()

    const profile = await prisma.profile.findUnique({
      where: { userId: session.user.id },
    })

    if (!profile) {
      return prisma.profile.create({
        data: {
          userId: session.user.id,
          name: session.user.name || session.user.email.split('@')[0],
          bio: '',
          photos: [],
          gender: '',
          location: '',
          interests: [],
        },
      })
    }

    return profile
  })

export const getProfileByUserId = createServerFn({ method: 'GET' })
  .inputValidator(z.string())
  .handler(async ({ data: userId }) => {
    await requireSession()
    return prisma.profile.findUnique({ where: { userId } })
  })

export const updateProfile = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    bio: z.string().max(500).optional(),
    photos: z.array(z.string()).max(6).optional(),
    name: z.string().max(100).optional(),
    gender: z.string().max(50).optional(),
    birthDate: z.string().optional(),
    location: z.string().max(200).optional(),
    interests: z.array(z.string().max(50)).max(20).optional(),
    job: z.string().max(200).optional(),
    lookingFor: z.array(z.enum(['dating', 'friends', 'networking'])).optional(),
    discoveryMode: z.enum(['global', 'event']).optional(),
    prefAgeMin: z.number().int().min(18).max(99).optional(),
    prefAgeMax: z.number().int().min(18).max(99).optional(),
    prefShowMe: z.enum(['Women', 'Men', 'Everyone']).optional(),
  }))
  .handler(async ({ data }) => {
    const session = await requireSession()
    const sanitized = sanitizeProfile(data)

    if (
      data.prefAgeMin !== undefined &&
      data.prefAgeMax !== undefined &&
      data.prefAgeMin > data.prefAgeMax
    ) {
      throw new Error('Minimum age cannot be greater than maximum age')
    }

    return prisma.profile.upsert({
      where: { userId: session.user.id },
      update: {
        ...(sanitized.bio !== undefined && { bio: sanitized.bio }),
        ...(data.photos !== undefined && { photos: data.photos }),
        ...(sanitized.name !== undefined && { name: sanitized.name }),
        ...(data.gender !== undefined && { gender: data.gender }),
        ...(data.birthDate !== undefined && { birthDate: data.birthDate }),
        ...(sanitized.location !== undefined && { location: sanitized.location }),
        ...(sanitized.interests !== undefined && { interests: sanitized.interests }),
        ...(sanitized.job !== undefined && { job: sanitized.job }),
        ...(data.lookingFor !== undefined && { lookingFor: data.lookingFor }),
        ...(data.discoveryMode !== undefined && { discoveryMode: data.discoveryMode }),
        ...(data.prefAgeMin !== undefined && { prefAgeMin: data.prefAgeMin }),
        ...(data.prefAgeMax !== undefined && { prefAgeMax: data.prefAgeMax }),
        ...(data.prefShowMe !== undefined && { prefShowMe: data.prefShowMe }),
      },
      create: {
        userId: session.user.id,
        name: sanitized.name || session.user.name || session.user.email.split('@')[0],
        bio: sanitized.bio ?? '',
        photos: data.photos ?? [],
        gender: data.gender ?? '',
        location: sanitized.location ?? '',
        interests: sanitized.interests ?? [],
        lookingFor: data.lookingFor ?? [],
        discoveryMode: data.discoveryMode ?? 'global',
        prefAgeMin: data.prefAgeMin ?? 18,
        prefAgeMax: data.prefAgeMax ?? 99,
        prefShowMe: data.prefShowMe ?? 'Everyone',
      },
    })
  })

export const verifyPhoto = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    imageBase64: z.string().min(1),
  }))
  .handler(async ({ data }) => {
    const { user } = await requireSession()

    // Validate data URL prefix
    if (!/^data:image\/(jpeg|jpg|png|webp|gif);base64,/.test(data.imageBase64)) {
      throw new Error('Invalid image format')
    }

    const base64Data = data.imageBase64.split(',')[1]
    if (!base64Data) throw new Error('Invalid image data')

    const key = `profiles/${user.id}/verification-${crypto.randomUUID()}.jpg`
    const buffer = Buffer.from(base64Data, 'base64')

    await r2Client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: 'image/jpeg',
      })
    )

    await prisma.profile.update({
      where: { userId: user.id },
      data: { verifiedAt: new Date() },
    })

    return { success: true }
  })
