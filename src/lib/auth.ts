import '@tanstack/react-start/server-only'
import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { prisma } from '#/db'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { CLIENT_IP_HEADER } from '#/lib/client-ip'

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
 * Whether the session cookie should carry the Secure attribute.
 *
 * Derived from BETTER_AUTH_URL's scheme, not NODE_ENV. better-auth already
 * gets this right on its own — createCookieGetter() computes `secure` from
 * baseURL's scheme when useSecureCookies is left unset (see
 * node_modules/better-auth/dist/cookies/index.mjs). A previous version of this
 * file passed `secure: NODE_ENV === 'production'` via defaultCookieAttributes,
 * which is spread in *after* that computed default and so silently overrode
 * it: any production deployment not yet behind HTTPS (a fresh docker-compose
 * host, a LAN address, a domain without a cert yet) forced Secure onto a
 * cookie issued over plain HTTP. Browsers refuse to store a Secure cookie set
 * from a non-HTTPS origin (localhost is exempted, which is why this was easy
 * to miss testing locally) — so sign-in would 200 with a Set-Cookie header
 * the browser silently discarded. The very next request, cookie-less, read as
 * signed out: an instant "logged out" on the first click, and a login that
 * never survived a refresh.
 */
const isHttps = baseURL.startsWith('https://')

if (process.env.NODE_ENV === 'production' && !isHttps && !baseURL.includes('localhost')) {
  // Not an error — the cookie is correctly issued without Secure so it
  // actually survives on a plain-HTTP origin. Flagged because it usually
  // means TLS hasn't been put in front yet, which is worth knowing in prod.
  console.warn(
    `[auth] BETTER_AUTH_URL is "${baseURL}" (not https) in production. Session cookies are ` +
      'being issued without the Secure attribute so they still work — but if this deployment ' +
      'is meant to be reachable over HTTPS, put a TLS-terminating proxy in front and point ' +
      'BETTER_AUTH_URL at the https origin; Secure will then be enabled automatically.',
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
    customRules: {
      // /get-session must be exempt. The limiter applies to *every* better-auth
      // path, not just the mutating ones, and its bucket is keyed on
      // (ip, path) — so this endpoint gets its own 20-per-60s ceiling. The app
      // blows through that on normal use: the root beforeLoad reads the session
      // on every navigation and all 71 requireSession() call sites do too, and
      // each one arrives as its own HTTP request, so the per-request
      // memoization in server/auth.ts cannot collapse them. Once the ceiling
      // was hit better-auth answered 429, resolveSession() read a non-ok
      // response as "no session", and the user was bounced to /login mid-click
      // and re-prompted for an OTP they had already passed.
      //
      // Exempting it costs nothing: it reads a cookie against the Session table
      // and creates no state, so there is no brute-force or enumeration surface
      // to throttle. Sign-in and sign-up keep their own (stricter) buckets.
      '/get-session': false,
    },
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
    // the resolved client address into this header, stripping any inbound value
    // first, so it is not client-controllable.
    ipAddress: {
      // Only ever this one header. It is set by server.prod.ts from the
      // already-resolved client address (see lib/client-ip.ts), so listing
      // x-forwarded-for alongside it would be strictly worse: better-auth reads
      // the *left-most* entry of that header, which is the part the caller
      // supplies, so a client could hand itself a fresh rate-limit bucket on
      // every request. TRUST_PROXY is honoured when the header is computed, not
      // here.
      ipAddressHeaders: [CLIENT_IP_HEADER],
    },
    // Ties the Secure attribute to the scheme in isHttps above, not NODE_ENV —
    // see the comment there. Leaving `secure` out of defaultCookieAttributes
    // is deliberate: it would be spread in after this and override it right
    // back to a static value, the exact bug this file used to have.
    useSecureCookies: isHttps,
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: 'lax',
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
