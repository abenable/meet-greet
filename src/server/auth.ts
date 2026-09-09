import { createServerFn } from '@tanstack/react-start'
import { getRequest, getRequestUrl } from '@tanstack/react-start/server'
import { z } from 'zod'
import { hashPassword } from '@better-auth/utils/password'
import { auth } from '#/lib/auth'
import { prisma } from '#/db'
import { sendOtpEmail } from '#/lib/email'
import { rateLimit } from '#/lib/rate-limit'
import { getClientIdentifier } from '#/lib/rate-limit.server'

const otpRateLimit = rateLimit({ windowMs: 60 * 1000, maxRequests: 3 })

async function fetchSessionFromAuthHandler(): Promise<{ session: any; user: any } | null> {
  const request = getRequest()
  const url = getRequestUrl()
  // Build a synthetic GET request to better-auth's /get-session endpoint
  const sessionReq = new Request(new URL('/api/auth/get-session', url.origin), {
    method: 'GET',
    headers: request.headers,
  })

  const response = await auth.handler(sessionReq)
  if (!response.ok) return null

  const data = await response.json()
  if (!data || !data.session) return null

  // Reject sessions for disabled accounts
  if (data.user?.id) {
    const [user, profile] = await Promise.all([
      prisma.user.findUnique({
        where: { id: data.user.id },
        select: { disabledAt: true, role: true, image: true },
      }),
      prisma.profile.findUnique({
        where: { userId: data.user.id },
        select: { photos: true },
      }),
    ])
    if (user?.disabledAt) return null
    data.user.role = user?.role ?? 'user'
    const profilePhoto = profile?.photos && profile.photos.length > 0 ? profile.photos[0] : null
    data.user.image = profilePhoto ?? user?.image ?? data.user.image ?? null
  }

  return data
}

export const getSession = createServerFn({ method: 'GET' })
  .handler(async () => {
    try {
      const data = await fetchSessionFromAuthHandler()
      return data
    } catch {
      return null
    }
  })

export const requireSession = createServerFn({ method: 'GET' })
  .handler(async () => {
    const data = await fetchSessionFromAuthHandler()
    if (!data?.user?.id) {
      throw new Error('Unauthorized')
    }
    return data
  })

export const requireAdmin = createServerFn({ method: 'GET' })
  .handler(async () => {
    const data = await fetchSessionFromAuthHandler()
    if (!data?.user?.id) {
      throw new Error('Unauthorized')
    }
    const user = await prisma.user.findUnique({
      where: { id: data.user.id },
      select: { role: true },
    })
    if (user?.role !== 'admin') {
      throw new Error('Forbidden')
    }
    return data
  })

export const disableMyAccount = createServerFn({ method: 'POST' })
  .handler(async () => {
    const session = await requireSession()
    const userId = session.user.id

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { disabledAt: new Date() },
      }),
      prisma.eventAttendee.updateMany({
        where: { userId, leftAt: null },
        data: { leftAt: new Date() },
      }),
      prisma.session.deleteMany({
        where: { userId },
      }),
    ])

    return { success: true }
  })

export const sendEmailVerificationOtp = createServerFn({ method: 'POST' })
  .inputValidator(z.string().email())
  .handler(async ({ data: email }) => {
    const identifier = `${getClientIdentifier()}:${email}`
    const rateLimitResult = await otpRateLimit(identifier)
    
    if (!rateLimitResult.success) {
      return { success: false, message: 'Too many requests. Please try again later.' }
    }

    const user = await prisma.user.findUnique({ where: { email } })
    if (!user) {
      return { success: false, message: 'We could not find an account with that email.' }
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString()

    await prisma.verification.deleteMany({
      where: { identifier: `email-verify:${email}` },
    })

    await prisma.verification.create({
      data: {
        identifier: `email-verify:${email}`,
        value: otp,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    })

    await sendOtpEmail({ to: email, otp, purpose: 'email-verify' })

    return { success: true }
  })

export const verifyEmailOtp = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    email: z.string().email(),
    otp: z.string().length(6),
  }))
  .handler(async ({ data }) => {
    const record = await prisma.verification.findUnique({
      where: {
        identifier_value: {
          identifier: `email-verify:${data.email}`,
          value: data.otp,
        },
      },
    })

    if (!record || record.expiresAt < new Date()) {
      return { valid: false }
    }

    await prisma.user.update({
      where: { email: data.email },
      data: { emailVerified: true },
    })

    await prisma.verification.delete({ where: { id: record.id } })

    return { valid: true }
  })

export const isEmailVerified = createServerFn({ method: 'POST' })
  .inputValidator(z.string().email())
  .handler(async ({ data: email }) => {
    const user = await prisma.user.findUnique({
      where: { email },
      select: { emailVerified: true },
    })
    return { verified: !!user?.emailVerified }
  })

export const sendPasswordResetOtp = createServerFn({ method: 'POST' })
  .inputValidator(z.string().email())
  .handler(async ({ data: email }) => {
    const user = await prisma.user.findUnique({ where: { email } })
    if (!user) {
      return { success: true }
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString()

    await prisma.verification.deleteMany({
      where: { identifier: `password-reset:${email}` },
    })

    await prisma.verification.create({
      data: {
        identifier: `password-reset:${email}`,
        value: otp,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    })

    await sendOtpEmail({ to: email, otp, purpose: 'password-reset' })

    return { success: true }
  })

export const verifyPasswordResetOtp = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    email: z.string().email(),
    otp: z.string().length(6),
  }))
  .handler(async ({ data }) => {
    const record = await prisma.verification.findUnique({
      where: {
        identifier_value: {
          identifier: `password-reset:${data.email}`,
          value: data.otp,
        },
      },
    })

    if (!record || record.expiresAt < new Date()) {
      return { valid: false }
    }

    return { valid: true }
  })

export const resetPasswordWithOtp = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    email: z.string().email(),
    otp: z.string().length(6),
    password: z.string().min(8),
  }))
  .handler(async ({ data }) => {
    const record = await prisma.verification.findUnique({
      where: {
        identifier_value: {
          identifier: `password-reset:${data.email}`,
          value: data.otp,
        },
      },
    })

    if (!record || record.expiresAt < new Date()) {
      return { success: false, message: 'Invalid or expired code. Please request a new one.' }
    }

    const user = await prisma.user.findUnique({ where: { email: data.email } })
    if (!user) {
      return { success: false, message: 'We could not find an account with that email.' }
    }

    const hashed = await hashPassword(data.password)

    const account = await prisma.account.findFirst({
      where: { userId: user.id, providerId: 'credential' },
    })

    if (account) {
      await prisma.account.update({
        where: { id: account.id },
        data: { password: hashed },
      })
    } else {
      await prisma.account.create({
        data: {
          userId: user.id,
          providerId: 'credential',
          accountId: data.email,
          password: hashed,
        },
      })
    }

    await prisma.verification.delete({
      where: { id: record.id },
    })

    return { success: true }
  })
