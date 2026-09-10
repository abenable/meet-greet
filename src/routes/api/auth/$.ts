import { createFileRoute } from '@tanstack/react-router'
import { auth } from '#/lib/auth'
import { invalidateSessionsAfterAuthMutation, sessionTokenFor } from '#/server/auth'

async function handleAuthRequest(request: Request, mutating: boolean) {
  // Read the token before the handler runs — a sign-out clears the cookie, so
  // afterwards there is nothing left to key the cache flush on.
  const token = mutating ? sessionTokenFor(request) : null

  try {
    return await auth.handler(request)
  } catch (error: any) {
    console.error('[Auth API Error]', error)
    return Response.json(
      { error: error?.message || 'Auth handler failed' },
      { status: 500 },
    )
  } finally {
    // Unconditional: a handler that threw partway may still have revoked
    // something, and dropping a cache entry is always safe.
    invalidateSessionsAfterAuthMutation(token)
  }
}

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }) => handleAuthRequest(request, false),
      POST: ({ request }) => handleAuthRequest(request, true),
    },
  },
})
