import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { deleteR2Object, getR2KeyFromUrl, r2Client, R2_BUCKET_NAME, R2_PUBLIC_URL } from '#/lib/r2'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { requireSession } from '#/server/auth'
import { prisma } from '#/db'

const MAX_BASE64_LENGTH = 15_000_000 // ~10MB JPEG after encoding
const DATA_URL_RE = /^data:image\/(jpeg|jpg|png|webp|gif);base64,/

/**
 * Resolve which R2 key prefixes the caller is allowed to write to or delete
 * from. Users own their profile folder; event organizers own their event's
 * folder. Anything else is rejected.
 *
 * This used to guard uploads only — deletes accepted any key in the bucket,
 * which let any signed-in user erase another user's photos (their URLs are
 * handed out by the swipe deck).
 */
async function assertCanWriteKey(userId: string, key: string) {
  if (key.includes('..')) {
    throw new Error('Invalid upload path')
  }

  if (key.startsWith(`profiles/${userId}/`)) return

  const eventMatch = key.match(/^events\/([^/]+)\//)
  if (eventMatch) {
    const eventId = eventMatch[1]!
    const event = await prisma.event.findUnique({
      where: { id: eventId },
      select: { createdById: true },
    })
    if (!event || event.createdById !== userId) {
      throw new Error('Unauthorized')
    }
    return
  }

  throw new Error('Invalid upload path')
}

export const uploadImage = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    key: z.string().min(1).max(512),
    imageBase64: z.string().min(1),
  }))
  .handler(async ({ data }) => {
    const { user } = await requireSession()

    // Check the encoded length before decoding — Buffer.from would otherwise
    // allocate the full payload before we could reject it.
    if (data.imageBase64.length > MAX_BASE64_LENGTH) {
      throw new Error('Image too large')
    }

    if (!DATA_URL_RE.test(data.imageBase64)) {
      throw new Error('Invalid image format')
    }

    const base64Data = data.imageBase64.split(',')[1]
    if (!base64Data) throw new Error('Invalid image data')

    await assertCanWriteKey(user.id, data.key)

    const buffer = Buffer.from(base64Data, 'base64')

    await r2Client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: data.key,
        Body: buffer,
        ContentType: 'image/jpeg',
      })
    )

    return { url: `${R2_PUBLIC_URL}/${data.key}` }
  })

export const deleteImage = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    url: z.string().url().max(2048),
  }))
  .handler(async ({ data }) => {
    const { user } = await requireSession()

    const key = getR2KeyFromUrl(data.url)
    if (!key) return { success: false as const }

    // Same ownership rule as upload: you can only delete out of your own
    // profile folder or an event you created.
    await assertCanWriteKey(user.id, key)

    await deleteR2Object(key)
    return { success: true as const }
  })
