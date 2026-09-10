import { describe, expect, it } from 'vitest'

/**
 * Mirror of parseChatId in server/conversations.ts. Kept as a local copy so the
 * test doesn't drag the whole server module (and Prisma) into the suite.
 * If the parser changes, change it in both places — these cases are the
 * contract.
 */
function parseChatId(
  chatId: string,
): { type: 'match'; matchId: string } | { type: 'org'; eventId: string; peerId: string } {
  if (chatId.startsWith('match_')) {
    const matchId = chatId.slice('match_'.length)
    if (!matchId) throw new Error('Invalid chat id')
    return { type: 'match', matchId }
  }

  if (chatId.startsWith('org_')) {
    const rest = chatId.slice('org_'.length)
    const separator = rest.indexOf('_')
    if (separator <= 0) throw new Error('Invalid chat id')
    const eventId = rest.slice(0, separator)
    const peerId = rest.slice(separator + 1)
    if (!eventId || !peerId) throw new Error('Invalid chat id')
    return { type: 'org', eventId, peerId }
  }

  throw new Error('Unknown chat type')
}

describe('parseChatId', () => {
  it('parses a match id', () => {
    expect(parseChatId('match_abc-123')).toEqual({ type: 'match', matchId: 'abc-123' })
  })

  it('parses an organizer id', () => {
    expect(parseChatId('org_event1_user2')).toEqual({
      type: 'org',
      eventId: 'event1',
      peerId: 'user2',
    })
  })

  it('keeps underscores in the peer id', () => {
    // The old implementation split on every underscore and took [1] and [2],
    // silently truncating ids that contained one.
    expect(parseChatId('org_evt_user_with_underscores')).toEqual({
      type: 'org',
      eventId: 'evt',
      peerId: 'user_with_underscores',
    })
  })

  it('rejects malformed ids', () => {
    expect(() => parseChatId('org_')).toThrow()
    expect(() => parseChatId('org_onlyevent')).toThrow()
    expect(() => parseChatId('match_')).toThrow()
    expect(() => parseChatId('nonsense')).toThrow()
  })
})
