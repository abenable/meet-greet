import { getRequest } from '@tanstack/react-start/server'
import { CLIENT_IP_HEADER, parseTrustedHops, resolveClientIp } from '#/lib/client-ip'

export { CLIENT_IP_HEADER }

const trustedHops = parseTrustedHops(process.env.TRUST_PROXY)

export function getClientIdentifier(): string {
  const request = getRequest()

  // In production server.prod.ts has already resolved this — applying the
  // TRUST_PROXY rules once, at the edge — and stripped any inbound value, so
  // the header is authoritative and unforgeable. Re-deriving it here would
  // risk the two paths disagreeing about which hop to trust.
  const resolved = request.headers.get(CLIENT_IP_HEADER)
  if (resolved?.trim()) return resolved.trim()

  // Dev runs under Vite with no such edge, so fall back to deriving it. There
  // is no socket address available here, hence no peerAddress.
  return resolveClientIp(request.headers, { trustedHops }) ?? 'unknown'
}

/**
 * Rate-limit key that survives IP rotation for authenticated callers by
 * combining the network identity with the user id.
 */
export function getUserScopedIdentifier(userId: string): string {
  return `${getClientIdentifier()}:${userId}`
}
