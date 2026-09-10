/**
 * Interpretation of better-auth's /get-session response.
 *
 * Split out from server/auth.ts so it can be tested without dragging Prisma
 * into the suite, and because the distinction it draws is easy to get wrong:
 *
 *   - 200 with a null/empty body  -> nobody is signed in. Return null.
 *   - any non-ok status           -> the lookup itself failed. Throw.
 *
 * Collapsing the second case into the first reports "signed out" whenever a
 * request is throttled or the database blips, which logs real users out
 * mid-session and sends them back through email verification.
 */

export interface RawSessionPayload {
  session: unknown
  user: { id: string; [key: string]: unknown }
  [key: string]: unknown
}

export class SessionLookupError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`Session lookup failed with status ${status}`)
    this.name = 'SessionLookupError'
    this.status = status
  }
}

export async function readSessionResponse(
  response: Response,
): Promise<RawSessionPayload | null> {
  if (!response.ok) {
    throw new SessionLookupError(response.status)
  }

  const data = await response.json().catch(() => null)
  if (!data || !(data as any).session || !(data as any).user?.id) return null

  return data as RawSessionPayload
}
