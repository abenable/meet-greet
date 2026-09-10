import { createServerFn } from '@tanstack/react-start'
import { getRequest, getRequestUrl } from '@tanstack/react-start/server'
import { z } from 'zod'
import { randomInt, timingSafeEqual } from 'node:crypto'
import { hashPassword } from '@better-auth/utils/password'
import { auth } from '#/lib/auth'
import { prisma } from '#/db'
import { sendOtpEmail } from '#/lib/email'
import { rateLimit } from '#/lib/rate-limit'
import { getClientIdentifier } from '#/lib/rate-limit.server'

/** Codes die after 10 minutes or OTP_MAX_ATTEMPTS wrong guesses, whichever first. */
const OTP_TTL_MS = 10 * 60 * 1000
const OTP_MAX_ATTEMPTS = 5

// Per-email and per-IP limits on sending. The per-IP bucket is what stops one
// host from walking a list of addresses; the per-email bucket is what stops a
// distributed mailbomb against one victim.
const otpSendPerEmail = rateLimit({ windowMs: 60 * 1000, maxRequests: 3 })
const otpSendPerIp = rateLimit({ windowMs: 60 * 1000, maxRequests: 10 })
// Verification attempts are additionally capped per IP, on top of the
// per-record attempt counter, so an attacker can't just request a fresh code
// every 5 guesses.
const otpVerifyPerIp = rateLimit({ windowMs: 10 * 60 * 1000, maxRequests: 20 })

export interface AppSessionUser {
  id: string
  email: string
  name: string | null
  image: string | null
  role: string
  emailVerified: boolean
}

export interface AppSession {
  session: any
  user: AppSessionUser
}

/**
 * Per-request memoization.
 *
 * Resolving a session costs a synthetic request through better-auth's handler
 * (one session query) plus a user lookup and a profile lookup. Every server
 * function calls requireSession(), and the root route calls getSession() on
 * every navigation, so without this a single page load repeats that work a
 * dozen times. The cache is keyed on the request object itself and dies with
 * it, so it can never leak one user's session into another's request.
 */
const sessionCache = new WeakMap<Request, Promise<AppSession | null>>()

function generateOtp(): string {
  // randomInt is CSPRNG-backed; Math.random is not, and a predictable
  // password-reset code is a full account takeover.
  return randomInt(0, 1_000_000).toString().padStart(6, '0')
}

/** Constant-time compare so a wrong code can't be recovered by timing. */
function otpMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

async function resolveSession(): Promise<AppSession | null> {
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
  if (!data || !data.session || !data.user?.id) return null

  const [user, profile] = await Promise.all([
    prisma.user.findUnique({
      where: { id: data.user.id },
      select: { disabledAt: true, role: true, image: true, emailVerified: true },
    }),
    prisma.profile.findUnique({
      where: { userId: data.user.id },
      select: { photos: true },
    }),
  ])

  // Reject sessions for disabled accounts.
  if (!user || user.disabledAt) return null

  data.user.role = user.role ?? 'user'
  data.user.emailVerified = user.emailVerified
  const profilePhoto = profile?.photos && profile.photos.length > 0 ? profile.photos[0] : null
  data.user.image = profilePhoto ?? user.image ?? data.user.image ?? null

  return data as AppSession
}

function fetchSessionFromAuthHandler(): Promise<AppSession | null> {
  const request = getRequest()
  const cached = sessionCache.get(request)
  if (cached) return cached

  const pending = resolveSession().catch((err) => {
    // Don't poison the cache with a rejection for the rest of the request.
    sessionCache.delete(request)
    throw err
  })
  sessionCache.set(request, pending)
  return pending
}

export const getSession = createServerFn({ method: 'GET' })
  .handler(async () => {
    try {
      return await fetchSessionFromAuthHandler()
    } catch {
      return null
    }
  })

/**
 * The single authorization chokepoint. Every server function goes through this,
 * so this is where "signed in" is defined: a live session, an account that
 * isn't disabled, and a confirmed email address.
 */
export const requireSession = createServerFn({ method: 'GET' })
  .handler(async (): Promise<AppSession> => {
    const data = await fetchSessionFromAuthHandler()
    if (!data?.user?.id) {
      throw new Error('Unauthorized')
    }
    if (!data.user.emailVerified) {
      throw new Error('Email not verified')
    }
    return data
  })

export const requireAdmin = createServerFn({ method: 'GET' })
  .handler(async (): Promise<AppSession> => {
    const data = await requireSession()
    if (data.user.role !== 'admin') {
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

async function issueOtp(identifier: string, email: string, purpose: 'email-verify' | 'password-reset') {
  const otp = generateOtp()

  await prisma.verification.deleteMany({ where: { identifier } })
  await prisma.verification.create({
    data: {
      identifier,
      value: otp,
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    },
  })

  await sendOtpEmail({ to: email, otp, purpose })
}

/**
 * Look up a code and consume an attempt. Returns null (and destroys the record
 * once the attempt budget is spent) rather than telling the caller why.
 */
async function consumeOtpAttempt(identifier: string, otp: string) {
  const records = await prisma.verification.findMany({ where: { identifier } })
  const record = records[0]

  if (!record) return null

  if (record.expiresAt < new Date()) {
    await prisma.verification.delete({ where: { id: record.id } }).catch(() => {})
    return null
  }

  if (otpMatches(record.value, otp)) return record

  const attempts = record.attempts + 1
  if (attempts >= OTP_MAX_ATTEMPTS) {
    await prisma.verification.delete({ where: { id: record.id } }).catch(() => {})
  } else {
    await prisma.verification
      .update({ where: { id: record.id }, data: { attempts } })
      .catch(() => {})
  }
  return null
}

export const sendEmailVerificationOtp = createServerFn({ method: 'POST' })
  .inputValidator(z.string().email())
  .handler(async ({ data: email }) => {
    const ip = getClientIdentifier()
    const [perIp, perEmail] = await Promise.all([
      otpSendPerIp(`otp-send:${ip}`),
      otpSendPerEmail(`otp-send:${email}`),
    ])

    if (!perIp.success || !perEmail.success) {
      return { success: false, message: 'Too many requests. Please try again in a minute.' }
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, emailVerified: true },
    })

    // Always report success. Telling the caller whether the address exists
    // turns this endpoint into an account-enumeration oracle — the
    // password-reset path already got this right.
    if (user && !user.emailVerified) {
      await issueOtp(`email-verify:${email}`, email, 'email-verify')
    }

    return { success: true as const }
  })

export const verifyEmailOtp = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    email: z.string().email(),
    otp: z.string().regex(/^\d{6}$/),
  }))
  .handler(async ({ data }) => {
    const throttle = await otpVerifyPerIp(`otp-verify:${getClientIdentifier()}`)
    if (!throttle.success) {
      return { valid: false as const, message: 'Too many attempts. Please try again later.' }
    }

    const record = await consumeOtpAttempt(`email-verify:${data.email}`, data.otp)
    if (!record) {
      return { valid: false as const, message: 'Invalid or expired code.' }
    }

    await prisma.user.update({
      where: { email: data.email },
      data: { emailVerified: true },
    })

    await prisma.verification.delete({ where: { id: record.id } }).catch(() => {})

    return { valid: true as const }
  })

export const sendPasswordResetOtp = createServerFn({ method: 'POST' })
  .inputValidator(z.string().email())
  .handler(async ({ data: email }) => {
    const ip = getClientIdentifier()
    const [perIp, perEmail] = await Promise.all([
      otpSendPerIp(`otp-send:${ip}`),
      otpSendPerEmail(`otp-send:${email}`),
    ])

    // Still report success — a rate-limit message keyed on the email would
    // leak whether the address exists.
    if (!perIp.success || !perEmail.success) {
      return { success: true as const }
    }

    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } })
    if (user) {
      await issueOtp(`password-reset:${email}`, email, 'password-reset')
    }

    return { success: true as const }
  })

export const verifyPasswordResetOtp = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    email: z.string().email(),
    otp: z.string().regex(/^\d{6}$/),
  }))
  .handler(async ({ data }) => {
    const throttle = await otpVerifyPerIp(`otp-verify:${getClientIdentifier()}`)
    if (!throttle.success) {
      return { valid: false as const }
    }

    // Peek without consuming the record — resetPasswordWithOtp does the real
    // check — but still spend an attempt so this endpoint can't be used as a
    // free oracle for the following one.
    const record = await consumeOtpAttempt(`password-reset:${data.email}`, data.otp)
    return { valid: !!record }
  })

export const resetPasswordWithOtp = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    email: z.string().email(),
    otp: z.string().regex(/^\d{6}$/),
    password: z.string().min(8).max(128),
  }))
  .handler(async ({ data }) => {
    const throttle = await otpVerifyPerIp(`otp-verify:${getClientIdentifier()}`)
    if (!throttle.success) {
      return { success: false as const, message: 'Too many attempts. Please try again later.' }
    }

    const record = await consumeOtpAttempt(`password-reset:${data.email}`, data.otp)
    if (!record) {
      return { success: false as const, message: 'Invalid or expired code. Please request a new one.' }
    }

    const user = await prisma.user.findUnique({ where: { email: data.email }, select: { id: true } })
    if (!user) {
      return { success: false as const, message: 'Invalid or expired code. Please request a new one.' }
    }

    const hashed = await hashPassword(data.password)

    const account = await prisma.account.findFirst({
      where: { userId: user.id, providerId: 'credential' },
      select: { id: true },
    })

    await prisma.$transaction(async (tx) => {
      if (account) {
        await tx.account.update({
          where: { id: account.id },
          data: { password: hashed },
        })
      } else {
        await tx.account.create({
          data: {
            userId: user.id,
            providerId: 'credential',
            accountId: data.email,
            password: hashed,
          },
        })
      }

      // Anyone holding a session for this account loses it. Without this, an
      // attacker who already signed in keeps their access after the owner
      // recovers the account.
      await tx.session.deleteMany({ where: { userId: user.id } })
      await tx.verification.delete({ where: { id: record.id } })
    })

    return { success: true as const }
  })
