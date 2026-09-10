import { describe, expect, it } from 'vitest'
import { parseTrustedHops, resolveClientIp } from './client-ip'

const headers = (init: Record<string, string>) => new Headers(init)

describe('parseTrustedHops', () => {
  it('defaults to not trusting the header', () => {
    expect(parseTrustedHops(undefined)).toBe(0)
    expect(parseTrustedHops('')).toBe(0)
    expect(parseTrustedHops('0')).toBe(0)
    expect(parseTrustedHops('false')).toBe(0)
  })

  it('accepts a hop count, and treats truthy spellings as one hop', () => {
    expect(parseTrustedHops('1')).toBe(1)
    expect(parseTrustedHops('true')).toBe(1)
    expect(parseTrustedHops('3')).toBe(3)
  })

  it('refuses nonsense rather than trusting it', () => {
    expect(parseTrustedHops('yes')).toBe(0)
    expect(parseTrustedHops('-2')).toBe(0)
  })
})

describe('resolveClientIp', () => {
  it('uses the socket address when no proxy is trusted', () => {
    const ip = resolveClientIp(headers({ 'x-forwarded-for': '9.9.9.9' }), {
      peerAddress: '10.0.0.5',
      trustedHops: 0,
    })
    expect(ip).toBe('10.0.0.5')
  })

  // The bug this guards: behind a proxy the socket address is the proxy, so
  // every user collapses into one rate-limit bucket.
  it('prefers the hop the trusted proxy appended over the socket address', () => {
    const ip = resolveClientIp(headers({ 'x-forwarded-for': '203.0.113.7' }), {
      peerAddress: '172.18.0.1',
      trustedHops: 1,
    })
    expect(ip).toBe('203.0.113.7')
  })

  // Proxies append, so the left-most entry is whatever the caller sent.
  // Reading [0] would let a client mint a fresh bucket per request.
  it('indexes forwarded hops from the right, ignoring caller-supplied entries', () => {
    const spoofed = headers({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 203.0.113.7' })
    expect(resolveClientIp(spoofed, { peerAddress: '172.18.0.1', trustedHops: 1 })).toBe('203.0.113.7')
    expect(resolveClientIp(spoofed, { peerAddress: '172.18.0.1', trustedHops: 2 })).toBe('2.2.2.2')
  })

  it('falls back to single-value proxy headers, but only when a proxy is trusted', () => {
    const h = headers({ 'x-real-ip': '203.0.113.9', 'cf-connecting-ip': '203.0.113.10' })
    expect(resolveClientIp(h, { peerAddress: '172.18.0.1', trustedHops: 1 })).toBe('203.0.113.9')
    expect(resolveClientIp(h, { peerAddress: '172.18.0.1', trustedHops: 0 })).toBe('172.18.0.1')
  })

  it('returns null when there is nothing trustworthy to go on', () => {
    expect(resolveClientIp(headers({}), { peerAddress: null, trustedHops: 0 })).toBeNull()
    expect(resolveClientIp(headers({}), { trustedHops: 2 })).toBeNull()
  })
})
