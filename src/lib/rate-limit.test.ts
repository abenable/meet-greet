import { describe, expect, it } from 'vitest'
import { rateLimit } from './rate-limit'

describe('rateLimit', () => {
  it('allows up to maxRequests then refuses', async () => {
    const limit = rateLimit({ windowMs: 60_000, maxRequests: 3 })
    const key = `allow-${Math.random()}`

    expect((await limit(key)).success).toBe(true)
    expect((await limit(key)).success).toBe(true)
    expect((await limit(key)).success).toBe(true)

    const refused = await limit(key)
    expect(refused.success).toBe(false)
    expect(refused.remaining).toBe(0)
  })

  it('reports remaining budget', async () => {
    const limit = rateLimit({ windowMs: 60_000, maxRequests: 5 })
    const key = `remaining-${Math.random()}`

    expect((await limit(key)).remaining).toBe(4)
    expect((await limit(key)).remaining).toBe(3)
  })

  it('keeps separate budgets per key', async () => {
    const limit = rateLimit({ windowMs: 60_000, maxRequests: 1 })
    const a = `a-${Math.random()}`
    const b = `b-${Math.random()}`

    expect((await limit(a)).success).toBe(true)
    expect((await limit(a)).success).toBe(false)
    expect((await limit(b)).success).toBe(true)
  })

  it('starts a fresh window once the old one expires', async () => {
    const limit = rateLimit({ windowMs: 1, maxRequests: 1 })
    const key = `expiry-${Math.random()}`

    expect((await limit(key)).success).toBe(true)
    await new Promise((r) => setTimeout(r, 5))
    // Previously entries were only reclaimed when the same key was hit again,
    // so single-use keys accumulated forever. Expiry still has to work.
    expect((await limit(key)).success).toBe(true)
  })
})
