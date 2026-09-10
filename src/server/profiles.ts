import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { prisma } from '#/db'
import { requireSession, invalidateSessionsForUser } from '#/server/auth'
import { sanitizeProfile } from '#/lib/sanitize'
import { r2Client, R2_BUCKET_NAME, R2_PUBLIC_URL } from '#/lib/r2'
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
    const session = await requireSession()
    const myId = session.user.id

    if (userId !== myId) {
      // Don't serve a profile across a block in either direction, and don't
      // serve disabled accounts.
      const [block, user] = await Promise.all([
        prisma.userBlock.findFirst({
          where: {
            OR: [
              { blockerId: myId, blockedId: userId },
              { blockerId: userId, blockedId: myId },
            ],
          },
          select: { id: true },
        }),
        prisma.user.findUnique({ where: { id: userId }, select: { disabledAt: true } }),
      ])
      if (block || !user || user.disabledAt) return null
    }

    const profile = await prisma.profile.findUnique({ where: { userId } })
    if (!profile) return null

    if (userId === myId) return profile

    // Verification captures are review material, not public profile content.
    const { verificationPhoto, verificationStatus, verificationSubmittedAt, ...visible } = profile
    return visible
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

    const saved = await prisma.profile.upsert({
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

    // The session carries the first photo as the avatar, so a photo change has
    // to drop the cached copy or the header keeps showing the old one. After
    // the write, not before — otherwise a concurrent read re-caches the stale
    // value in the gap.
    if (data.photos !== undefined) invalidateSessionsForUser(session.user.id)

    return saved
  })

const MAX_BASE64_LENGTH = 15_000_000 // ~10MB JPEG after encoding

/**
 * Submit a photo for verification review.
 *
 * This deliberately does NOT set verifiedAt. The badge is a safety signal that
 * other users act on when deciding whether to meet a stranger, so it is granted
 * only by an admin through reviewVerification(). Previously this endpoint
 * stamped verifiedAt for anyone who posted any image.
 */
export const submitPhotoVerification = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    imageBase64: z.string().min(1),
  }))
  .handler(async ({ data }) => {
    const { user } = await requireSession()

    // Length check before decoding, so an oversized payload can't be
    // materialised into a Buffer first.
    if (data.imageBase64.length > MAX_BASE64_LENGTH) {
      throw new Error('Image too large')
    }

    if (!/^data:image\/(jpeg|jpg|png|webp);base64,/.test(data.imageBase64)) {
      throw new Error('Invalid image format')
    }

    const base64Data = data.imageBase64.split(',')[1]
    if (!base64Data) throw new Error('Invalid image data')

    const existing = await prisma.profile.findUnique({
      where: { userId: user.id },
      select: { verifiedAt: true, verificationStatus: true },
    })
    if (existing?.verifiedAt) {
      return { success: false as const, message: 'Your profile is already verified.' }
    }
    if (existing?.verificationStatus === 'pending') {
      return { success: false as const, message: 'Your submission is already being reviewed.' }
    }

    const key = `profiles/${user.id}/verification-${crypto.randomUUID()}.jpg`

    await r2Client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: Buffer.from(base64Data, 'base64'),
        ContentType: 'image/jpeg',
      })
    )

    await prisma.profile.update({
      where: { userId: user.id },
      data: {
        verificationPhoto: `${R2_PUBLIC_URL}/${key}`,
        verificationSubmittedAt: new Date(),
        verificationStatus: 'pending',
      },
    })

    return { success: true as const }
  })

export const getMyVerificationStatus = createServerFn({ method: 'GET' })
  .handler(async () => {
    const { user } = await requireSession()
    const profile = await prisma.profile.findUnique({
      where: { userId: user.id },
      select: { verifiedAt: true, verificationStatus: true, verificationSubmittedAt: true },
    })
    return {
      verifiedAt: profile?.verifiedAt ?? null,
      status: profile?.verificationStatus ?? null,
      submittedAt: profile?.verificationSubmittedAt ?? null,
    }
  })
