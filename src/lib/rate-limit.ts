/**
 * Fixed-window rate limiting.
 *
 * The default store keeps counters in this process's memory. That is correct
 * for a single app instance (what docker-compose runs today) but does not
 * coordinate across replicas — the moment you scale out, swap in a shared
 * store by calling `setRateLimitStore()` at boot with a Redis-backed
 * implementation of `RateLimitStore`. Nothing else has to change.
 */

export interface RateLimitConfig {
  windowMs: number
  maxRequests: number
}

export interface RateLimitResult {
  success: boolean
  remaining: number
  /** Epoch ms at which the current window expires. */
  resetAt: number
}

export interface RateLimitStore {
  /** Increment the counter for `key` and report the state after incrementing. */
  hit(key: string, config: RateLimitConfig): Promise<RateLimitResult>
}

/** Hard cap on tracked keys, so a flood of unique keys can't exhaust memory. */
const MAX_KEYS = 50_000
/** How often the sweep runs, at most. */
const SWEEP_INTERVAL_MS = 60_000

interface Entry {
  count: number
  resetAt: number
}

class MemoryRateLimitStore implements RateLimitStore {
  // Map preserves insertion order, which gives us cheap oldest-first eviction.
  private entries = new Map<string, Entry>()
  private lastSweep = 0

  async hit(key: string, config: RateLimitConfig): Promise<RateLimitResult> {
    const now = Date.now()
    this.sweep(now)

    const existing = this.entries.get(key)

    if (!existing || existing.resetAt <= now) {
      // Re-insert so the key moves to the end of the eviction order.
      this.entries.delete(key)
      this.entries.set(key, { count: 1, resetAt: now + config.windowMs })
      this.evictIfOversized()
      return { success: true, remaining: config.maxRequests - 1, resetAt: now + config.windowMs }
    }

    if (existing.count >= config.maxRequests) {
      return { success: false, remaining: 0, resetAt: existing.resetAt }
    }

    existing.count++
    return {
      success: true,
      remaining: config.maxRequests - existing.count,
      resetAt: existing.resetAt,
    }
  }

  /**
   * Drop expired entries. The previous implementation only reclaimed a key when
   * that exact key was hit again, so single-use keys (ip:email pairs) leaked
   * forever.
   */
  private sweep(now: number) {
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return
    this.lastSweep = now
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key)
    }
  }

  private evictIfOversized() {
    if (this.entries.size <= MAX_KEYS) return
    const overflow = this.entries.size - MAX_KEYS
    let removed = 0
    for (const key of this.entries.keys()) {
      this.entries.delete(key)
      if (++removed >= overflow) break
    }
  }
}

let store: RateLimitStore = new MemoryRateLimitStore()

/** Replace the backing store (e.g. with Redis) before serving traffic. */
export function setRateLimitStore(next: RateLimitStore) {
  store = next
}

export function rateLimit(config: RateLimitConfig) {
  return (identifier: string): Promise<RateLimitResult> => store.hit(identifier, config)
}
