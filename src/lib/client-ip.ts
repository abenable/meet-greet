/**
 * Resolving the client IP.
 *
 * This module is deliberately dependency-free: server.prod.ts imports it with a
 * relative path at runtime, so it must never import anything under the `#/*`
 * alias (Bun cannot resolve those — see the note in server.prod.ts).
 *
 * There is exactly one trustworthy answer per request, and it is computed once,
 * by the edge of the process, into CLIENT_IP_HEADER. Everything downstream
 * (our OTP limiters, better-auth's own limiter) reads that header and nothing
 * else. Letting each consumer re-derive the address from x-forwarded-for is how
 * you end up with one consumer trusting a hop the other doesn't.
 */

/**
 * Set by server.prod.ts from the resolved client address, after stripping any
 * inbound value — so unlike x-forwarded-for it cannot be spoofed by a client.
 */
export const CLIENT_IP_HEADER = 'x-mag-client-ip'

/**
 * TRUST_PROXY says how many right-most `x-forwarded-for` entries were appended
 * by proxies we control. 0 (the default) means we are exposed directly and the
 * header is entirely client-controlled, so it is ignored.
 *
 * Set TRUST_PROXY=1 behind a single reverse proxy that overwrites
 * x-forwarded-for (nginx, Caddy, Cloudflare, a cloud load balancer); set it to
 * the hop count if you run more than one.
 */
export function parseTrustedHops(raw: string | undefined | null): number {
  if (!raw) return 0
  if (raw === 'true') return 1
  if (raw === 'false') return 0
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return Math.floor(parsed)
}

export interface ResolveClientIpOptions {
  /** Peer address from the socket, when the runtime can supply one. */
  peerAddress?: string | null
  trustedHops: number
}

/**
 * Returns the client address, or null when it cannot be established.
 *
 * Header values are only consulted when TRUST_PROXY says a proxy we control
 * rewrites them. Note that we index from the *right*: proxies append, so the
 * left-most entry is whatever the original caller sent and is forgeable. Taking
 * `[0]` — the obvious reading, and what better-auth's own header handling does —
 * lets any caller mint a fresh rate-limit bucket per request.
 */
export function resolveClientIp(
  headers: Headers,
  { peerAddress, trustedHops }: ResolveClientIpOptions,
): string | null {
  if (trustedHops > 0) {
    const forwarded = headers.get('x-forwarded-for')
    if (forwarded) {
      const hops = forwarded.split(',').map((hop) => hop.trim()).filter(Boolean)
      const candidate = hops[hops.length - trustedHops]
      if (candidate) return candidate
    }

    // Single-value headers set by the proxy itself; no hop list to index into.
    const realIp = headers.get('x-real-ip')
    if (realIp?.trim()) return realIp.trim()

    const cfIp = headers.get('cf-connecting-ip')
    if (cfIp?.trim()) return cfIp.trim()
  }

  return peerAddress?.trim() || null
}
