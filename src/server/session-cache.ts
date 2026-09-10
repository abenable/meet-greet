/**
 * Cross-request session cache.
 *
 * The WeakMap in server/auth.ts memoizes within a single request, which is
 * useless for the shape this app actually has: every server function arrives as
 * its own HTTP request, so one navigation resolves the session ten-plus times
 * and pays three queries each time.
 *
 * This cache is keyed on the session token from the cookie, so entries are
 * per-session by construction and cannot leak across users. The TTL is short
 * and deliberately so — see the note on revocation below.
 */

interface Entry<T> {
  value: T
  userId: string
  expiresAt: number
}

/** Cap on tracked sessions, so a flood of distinct tokens can't exhaust memory. */
const MAX_ENTRIES = 10_000
const SWEEP_INTERVAL_MS = 60_000

export class SessionCache<T> {
  // Map preserves insertion order, which gives cheap oldest-first eviction.
  private entries = new Map<string, Entry<T>>()
  private tokensByUser = new Map<string, Set<string>>()
  private lastSweep = 0

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number = MAX_ENTRIES,
  ) {}

  get enabled(): boolean {
    return this.ttlMs > 0
  }

  get(token: string, now = Date.now()): T | undefined {
    if (!this.enabled) return undefined
    const entry = this.entries.get(token)
    if (!entry) return undefined
    if (entry.expiresAt <= now) {
      this.deleteToken(token)
      return undefined
    }
    return entry.value
  }

  set(token: string, userId: string, value: T, now = Date.now()): void {
    if (!this.enabled) return
    this.sweep(now)

    // Re-insert so the token moves to the end of the eviction order.
    this.deleteToken(token)
    this.entries.set(token, { value, userId, expiresAt: now + this.ttlMs })

    let tokens = this.tokensByUser.get(userId)
    if (!tokens) {
      tokens = new Set()
      this.tokensByUser.set(userId, tokens)
    }
    tokens.add(token)

    this.evictIfOversized()
  }

  /** The user a cached token belongs to, if we still hold it. */
  userIdFor(token: string): string | undefined {
    return this.entries.get(token)?.userId
  }

  deleteToken(token: string): void {
    const entry = this.entries.get(token)
    if (!entry) return
    this.entries.delete(token)
    const tokens = this.tokensByUser.get(entry.userId)
    if (tokens) {
      tokens.delete(token)
      if (tokens.size === 0) this.tokensByUser.delete(entry.userId)
    }
  }

  /**
   * Drop every cached session for one user. Call this from anywhere that
   * revokes sessions or changes what a session is allowed to do — password
   * reset, disabling an account, a role change, email verification. Without it
   * those take up to ttlMs to bite, which for a role change means a demoted
   * admin keeps admin.
   */
  invalidateUser(userId: string): void {
    const tokens = this.tokensByUser.get(userId)
    if (!tokens) return
    for (const token of tokens) this.entries.delete(token)
    this.tokensByUser.delete(userId)
  }

  clear(): void {
    this.entries.clear()
    this.tokensByUser.clear()
  }

  get size(): number {
    return this.entries.size
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return
    this.lastSweep = now
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now) this.deleteToken(token)
    }
  }

  private evictIfOversized(): void {
    if (this.entries.size <= this.maxEntries) return
    const overflow = this.entries.size - this.maxEntries
    let removed = 0
    for (const token of [...this.entries.keys()]) {
      this.deleteToken(token)
      if (++removed >= overflow) break
    }
  }
}

/**
 * How long a resolved session may be reused across requests.
 *
 * This is the one knob that trades latency against revocation lag, so the
 * default is small. cookieCache is off precisely so that deleting a session row
 * takes effect immediately (see lib/auth.ts); a long TTL here would hand that
 * back. Five seconds covers the burst of server-function calls a single
 * navigation makes — which is the entire problem being solved — and every
 * revocation path we control calls invalidateUser() anyway, so the window only
 * applies to session deletions that happen outside this app.
 *
 * Set SESSION_CACHE_TTL_MS=0 to disable.
 */
const DEFAULT_TTL_MS = 5_000

export function resolveSessionCacheTtlMs(
  raw: string | undefined | null = process.env.SESSION_CACHE_TTL_MS,
): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_TTL_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_TTL_MS
  return Math.floor(parsed)
}
