import { getRequest } from '@tanstack/react-start/server'

/**
 * `x-forwarded-for` is client-controlled unless a proxy you trust rewrites it,
 * so we only read it when TRUST_PROXY says a proxy is in front of us.
 * Otherwise any caller could mint a fresh rate-limit bucket per request just by
 * varying the header.
 *
 * Set TRUST_PROXY=1 when running behind a reverse proxy that overwrites
 * x-forwarded-for (nginx, Caddy, Cloudflare, a cloud load balancer). Set
 * TRUST_PROXY to a number to skip that many right-most (proxy-appended) hops.
 */
const TRUST_PROXY = process.env.TRUST_PROXY ?? '0'
const trustedHops = TRUST_PROXY === '1' || TRUST_PROXY === 'true' ? 1 : Number(TRUST_PROXY) || 0

/**
 * Set by server.prod.ts from Bun's `server.requestIP()`, after stripping any
 * inbound value — so unlike x-forwarded-for it cannot be spoofed by a client.
 */
export const CLIENT_IP_HEADER = 'x-mag-client-ip'

export function getClientIdentifier(): string {
  const request = getRequest()

  if (trustedHops > 0) {
    const forwarded = request.headers.get('x-forwarded-for')
    if (forwarded) {
      // The right-most entries are appended by proxies we control, so the
      // trusted client address sits `trustedHops` from the end. Anything
      // further left was supplied by the caller and cannot be trusted.
      const hops = forwarded.split(',').map((h) => h.trim()).filter(Boolean)
      const candidate = hops[hops.length - trustedHops]
      if (candidate) return candidate
    }

    const realIp = request.headers.get('x-real-ip')
    if (realIp) return realIp.trim()
  }

  // Peer address injected by server.prod.ts from Bun's server.requestIP().
  // A Bun `Request` carries no socket, so without this every caller would
  // collapse into one shared bucket and the OTP limits would throttle the
  // whole app at once.
  const peerAddress = request.headers.get(CLIENT_IP_HEADER)
  if (peerAddress) return peerAddress.trim()

  const cfIp = request.headers.get('cf-connecting-ip')
  if (cfIp) return cfIp.trim()

  return 'unknown'
}

/**
 * Rate-limit key that survives IP rotation for authenticated callers by
 * combining the network identity with the user id.
 */
export function getUserScopedIdentifier(userId: string): string {
  return `${getClientIdentifier()}:${userId}`
}
