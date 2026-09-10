import { describe, expect, it } from 'vitest'
import { SessionCache, resolveSessionCacheTtlMs } from './session-cache'

interface Session { userId: string; role: string }

const make = (ttl = 5_000, max?: number) => new SessionCache<Session>(ttl, max)

describe('SessionCache', () => {
  it('serves a cached session within the TTL and drops it after', () => {
    const cache = make(1_000)
    cache.set('tok', 'u1', { userId: 'u1', role: 'user' }, 0)

    expect(cache.get('tok', 500)?.userId).toBe('u1')
    expect(cache.get('tok', 1_001)).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it('keeps sessions separate per token', () => {
    const cache = make()
    cache.set('a', 'u1', { userId: 'u1', role: 'user' })
    cache.set('b', 'u2', { userId: 'u2', role: 'admin' })

    expect(cache.get('a')?.userId).toBe('u1')
    expect(cache.get('b')?.userId).toBe('u2')
  })

  // Every revocation path depends on this: a demoted admin must not keep admin,
  // and a reset password must not leave the attacker's session working.
  it('invalidateUser drops every token for that user and nobody else', () => {
    const cache = make()
    cache.set('phone', 'u1', { userId: 'u1', role: 'admin' })
    cache.set('laptop', 'u1', { userId: 'u1', role: 'admin' })
    cache.set('other', 'u2', { userId: 'u2', role: 'user' })

    cache.invalidateUser('u1')

    expect(cache.get('phone')).toBeUndefined()
    expect(cache.get('laptop')).toBeUndefined()
    expect(cache.get('other')?.userId).toBe('u2')
  })

  it('reports the owner of a token so a flush can widen to the whole user', () => {
    const cache = make()
    cache.set('tok', 'u1', { userId: 'u1', role: 'user' })
    expect(cache.userIdFor('tok')).toBe('u1')
    expect(cache.userIdFor('missing')).toBeUndefined()
  })

  it('deleteToken clears the per-user index too, so users do not leak', () => {
    const cache = make()
    cache.set('tok', 'u1', { userId: 'u1', role: 'user' })
    cache.deleteToken('tok')
    cache.invalidateUser('u1') // must not throw on a now-empty index
    expect(cache.size).toBe(0)
  })

  it('evicts oldest-first rather than growing without bound', () => {
    const cache = make(5_000, 2)
    cache.set('a', 'u1', { userId: 'u1', role: 'user' })
    cache.set('b', 'u2', { userId: 'u2', role: 'user' })
    cache.set('c', 'u3', { userId: 'u3', role: 'user' })

    expect(cache.size).toBe(2)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('c')?.userId).toBe('u3')
  })

  it('caches nothing at all when the TTL is zero', () => {
    const cache = make(0)
    cache.set('tok', 'u1', { userId: 'u1', role: 'user' })
    expect(cache.get('tok')).toBeUndefined()
    expect(cache.enabled).toBe(false)
  })
})

describe('resolveSessionCacheTtlMs', () => {
  it('defaults to a short window and honours an explicit override', () => {
    expect(resolveSessionCacheTtlMs(undefined)).toBe(5_000)
    expect(resolveSessionCacheTtlMs('')).toBe(5_000)
    expect(resolveSessionCacheTtlMs('1500')).toBe(1_500)
    expect(resolveSessionCacheTtlMs('0')).toBe(0)
  })

  it('falls back to the default rather than trusting a bad value', () => {
    expect(resolveSessionCacheTtlMs('abc')).toBe(5_000)
    expect(resolveSessionCacheTtlMs('-1')).toBe(5_000)
  })
})
