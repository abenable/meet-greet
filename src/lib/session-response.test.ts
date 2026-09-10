import { describe, expect, it } from 'vitest'
import { SessionLookupError, readSessionResponse } from './session-response'

function json(body: unknown, status = 200) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('readSessionResponse', () => {
  it('returns the payload for a live session', async () => {
    const data = await readSessionResponse(
      json({ session: { id: 's1' }, user: { id: 'u1', email: 'a@b.c' } }),
    )
    expect(data?.user.id).toBe('u1')
  })

  it('returns null when nobody is signed in', async () => {
    // better-auth answers 200 with a null body — not an error status.
    expect(await readSessionResponse(json(null))).toBeNull()
  })

  it('returns null for a malformed or half-populated payload', async () => {
    expect(await readSessionResponse(json({ session: { id: 's1' } }))).toBeNull()
    expect(await readSessionResponse(json({ user: { id: 'u1' } }))).toBeNull()
    expect(await readSessionResponse(json({ session: {}, user: {} }))).toBeNull()
    expect(await readSessionResponse(json(undefined))).toBeNull()
  })

  // The regression this file exists for: a throttled or failing lookup must not
  // read as "signed out". It used to, which bounced signed-in users to /login on
  // their next click and then re-prompted them for an OTP they had already passed.
  it.each([429, 500, 502, 401, 403])('throws rather than reporting no session on %i', async (status) => {
    const promise = readSessionResponse(json({ message: 'nope' }, status))
    await expect(promise).rejects.toBeInstanceOf(SessionLookupError)
    await expect(promise).rejects.toMatchObject({ status })
  })
})
