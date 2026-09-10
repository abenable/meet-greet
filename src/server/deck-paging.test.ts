import { describe, expect, it } from 'vitest'

/**
 * Offset paging for the swipe deck.
 *
 * Mirrors the windowing logic in buildSwipeDeck (src/server/events.ts): fetch
 * `limit + 1` rows from `offset`, return every row in that window that passes
 * the in-JS age filter, and advance `nextOffset` by the rows *consumed from the
 * database window* — never by more.
 *
 * The bug this guards against: an earlier version over-fetched `limit * 4`
 * rows, returned only `limit` of them, and still advanced nextOffset by the
 * full fetched count. Every page after the first then started 4 windows later,
 * so roughly three quarters of the pool was never returned to any caller.
 */
function pageDeck<T>(
  pool: T[],
  offset: number,
  limit: number,
  isEligible: (row: T) => boolean,
): { items: T[]; nextOffset: number | null } {
  const fetchSize = limit
  const rows = pool.slice(offset, offset + fetchSize + 1)

  const hasMore = rows.length > fetchSize
  const candidates = hasMore ? rows.slice(0, -1) : rows

  return {
    items: candidates.filter(isEligible),
    nextOffset: hasMore ? offset + candidates.length : null,
  }
}

function collectAllPages<T>(
  pool: T[],
  limit: number,
  isEligible: (row: T) => boolean = () => true,
): T[] {
  const seen: T[] = []
  let offset: number | null = 0
  let guard = 0

  while (offset !== null) {
    if (++guard > 1000) throw new Error('pagination did not terminate')
    const page: { items: T[]; nextOffset: number | null } = pageDeck(
      pool,
      offset,
      limit,
      isEligible,
    )
    seen.push(...page.items)
    offset = page.nextOffset
  }

  return seen
}

describe('swipe deck paging', () => {
  it('returns every profile in the pool across pages', () => {
    const pool = Array.from({ length: 97 }, (_, i) => i)
    expect(collectAllPages(pool, 10)).toEqual(pool)
  })

  it('never returns the same profile twice', () => {
    const pool = Array.from({ length: 250 }, (_, i) => i)
    const seen = collectAllPages(pool, 30)
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('still visits every candidate when the age filter removes most of them', () => {
    // The filter runs after the window is fetched, so pages come back short —
    // but paging must not skip the rows it filtered out.
    const pool = Array.from({ length: 200 }, (_, i) => i)
    const eligible = (n: number) => n % 7 === 0
    expect(collectAllPages(pool, 10, eligible)).toEqual(pool.filter(eligible))
  })

  it('terminates on an empty pool', () => {
    expect(collectAllPages([], 30)).toEqual([])
  })

  it('advances by at most the page size', () => {
    const pool = Array.from({ length: 100 }, (_, i) => i)
    const page = pageDeck(pool, 0, 30, () => true)
    expect(page.nextOffset).toBe(30)
  })

  it('reports no next page once the pool is exhausted', () => {
    const pool = Array.from({ length: 10 }, (_, i) => i)
    expect(pageDeck(pool, 0, 30, () => true).nextOffset).toBeNull()
  })
})
