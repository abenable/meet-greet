import '@tanstack/react-start/server-only'
import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { prisma } from '#/db'
import { tanstackStartCookies } from 'better-auth/tanstack-start'

const baseURL = process.env.BETTER_AUTH_URL

if (!baseURL) {
  throw new Error('BETTER_AUTH_URL must be set — it anchors cookie scope and origin checks.')
}

if (process.env.NODE_ENV === 'production' && baseURL.includes('localhost')) {
  console.warn(
    `[auth] BETTER_AUTH_URL is "${baseURL}" in production. Behind a real domain this ` +
      'breaks cookie scoping and origin checks. Set it to the public origin.',
  )
}

/**
 * Origins allowed to drive auth requests. Defaults to the app's own origin;
 * add more (a separate marketing domain, a preview deployment) via
 * ADDITIONAL_TRUSTED_ORIGINS as a comma-separated list.
 */
const trustedOrigins = [
  baseURL,
  ...(process.env.ADDITIONAL_TRUSTED_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean) ?? []),
]

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),
  basePath: '/api/auth',
  baseURL,
  trustedOrigins,
  emailAndPassword: {
    enabled: true,
    // A session is issued at sign-up so the OTP screen has an identity to work
    // with, but it is inert until the address is confirmed: requireSession()
    // in server/auth.ts rejects every unverified session, which is the
    // chokepoint every server function already goes through. Enforcement used
    // to live only in login.tsx, after the cookie had already been set.
    autoSignIn: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
  },
  // better-auth's own limiter, in front of its endpoints (sign-in, sign-up,
  // token refresh). Our OTP endpoints are limited separately in server/auth.ts.
  rateLimit: {
    enabled: true,
    window: 60,
    max: 20,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    // cookieCache is deliberately OFF. It serves session data straight from the
    // signed cookie without touching the Session table, which would leave a
    // stolen session working for up to maxAge seconds *after*
    // resetPasswordWithOtp deletes it — defeating the revocation that password
    // reset exists to provide. The per-request memoization in server/auth.ts
    // already removes the repeated-lookup cost this would have saved.
  },
  advanced: {
    // Bun's Request exposes no socket, so better-auth cannot find a client IP
    // on its own and silently skips its own rate limiting ("Rate limiting
    // skipped: could not determine client IP address"). server.prod.ts injects
    // the peer address from server.requestIP() into this header, stripping any
    // inbound value first, so it is not client-controllable.
    ipAddress: {
      ipAddressHeaders: [
        'x-mag-client-ip',
        ...(process.env.TRUST_PROXY && process.env.TRUST_PROXY !== '0'
          ? ['x-forwarded-for', 'x-real-ip']
          : []),
      ],
    },
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    },
  },
  databaseHooks: {
    session: {
      create: {
        async before(session) {
          const user = await prisma.user.findUnique({
            where: { id: (session as any).userId },
            select: { disabledAt: true },
          })
          if (user?.disabledAt) {
            return false
          }
        },
      },
    },
    user: {
      create: {
        async before(userData) {
          const existing = await prisma.user.findUnique({
            where: { email: (userData as any).email },
            select: { disabledAt: true },
          })
          if (existing?.disabledAt) {
            return false
          }
        },
      },
    },
  },
  plugins: [tanstackStartCookies()],
})
