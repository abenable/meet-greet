declare const Bun: any
import './dist/server/instrument.server.mjs'

import { stat } from 'fs/promises'
import { join, normalize, resolve, sep } from 'path'

// Validate required environment variables
const requiredEnvVars = ['DATABASE_URL', 'BETTER_AUTH_SECRET', 'BETTER_AUTH_URL']
const missingVars = requiredEnvVars.filter(v => !process.env[v])
if (missingVars.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingVars.join(', ')}`)
  process.exit(1)
}
console.log('✅ Environment variables validated')

// @ts-ignore - built output, not present at type-check time
import serverEntry from './dist/server/server.js'

// NOTE: nothing here imports from ./src directly. Those modules use the `#/*`
// alias, which Vite resolves at build time via tsconfig paths — but Node's
// subpath-imports spec rejects keys starting with `#/`, so Bun >= 1.4.2 cannot
// resolve them at runtime. Everything this server needs from the app goes
// through the bundled handler in dist/, via serverEntry.fetch().

const port = Number(process.env.PORT) || 3000
const clientDir = './dist/client'

// Origin used for internal serverEntry.fetch() calls once we no longer have a
// request URL to derive one from (e.g. inside a WebSocket message handler).
const publicOrigin = process.env.BETTER_AUTH_URL || `http://127.0.0.1:${port}`

/**
 * Header carrying the peer address, set by this server on every request.
 *
 * A Bun `Request` exposes no socket, so the app layer cannot see the client
 * address on its own — without this, getClientIdentifier() falls back to a
 * single shared bucket and every user shares one rate limit, which turns the
 * OTP limiter into an app-wide denial of service.
 *
 * Any inbound value is stripped first, so a client cannot forge it.
 */
const CLIENT_IP_HEADER = 'x-mag-client-ip'

function withClientIp(request: Request, server: any): Request {
  const headers = new Headers(request.headers)
  headers.delete(CLIENT_IP_HEADER)

  const address = server.requestIP?.(request)?.address
  if (address) headers.set(CLIENT_IP_HEADER, address)

  return new Request(request, { headers })
}

const mimeTypes: Record<string, string> = {
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}

function getMimeType(path: string): string {
  const ext = path.slice(path.lastIndexOf('.'))
  return mimeTypes[ext] || 'application/octet-stream'
}

const clientRoot = resolve(clientDir)

/**
 * Map a request path to a file under dist/client, or null if it escapes that
 * directory. `new URL()` already collapses dot segments, but percent-encoded
 * ones survive it — decode first, then confirm the resolved path is still
 * inside the root.
 */
function resolveStaticPath(pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null

  const candidate = resolve(join(clientRoot, normalize(decoded)))
  if (candidate !== clientRoot && !candidate.startsWith(clientRoot + sep)) {
    return null
  }
  return candidate
}

/**
 * Baseline security headers. None of these were set before.
 *
 * The CSP allows inline scripts and styles because the SSR shell emits an
 * inline theme bootstrap and Tailwind injects styles; tighten to a nonce when
 * that changes. `connect-src` includes ws:/wss: for the live chat socket.
 */
const securityHeaders: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  ...(process.env.NODE_ENV === 'production'
    ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' }
    : {}),
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${process.env.R2_PUBLIC_URL ?? ''}`.trim(),
    `media-src 'self' blob: ${process.env.R2_PUBLIC_URL ?? ''}`.trim(),
    "connect-src 'self' ws: wss:",
    "font-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '),
}

interface WsAuthResult {
  authenticated: boolean
  userId?: string
  canSubscribe?: boolean
  peerId?: string | null
}

/**
 * Ask the bundled app who this caller is, and optionally whether they may
 * subscribe to an event topic. Runs through serverEntry.fetch() rather than
 * importing src/ — see the note at the top of this file.
 */
async function authorizeWs(
  origin: string,
  headers: Headers,
  eventId?: string,
  chatId?: string,
): Promise<WsAuthResult> {
  try {
    const url = new URL('/api/ws-auth', origin)
    if (eventId) url.searchParams.set('eventId', eventId)
    if (chatId) url.searchParams.set('chatId', chatId)

    const response = await serverEntry.fetch(
      new Request(url, { method: 'GET', headers }),
    )
    if (!response.ok) return { authenticated: false }
    return (await response.json()) as WsAuthResult
  } catch (error) {
    console.error('[ws] authorization failed:', error)
    return { authenticated: false }
  }
}

function withSecurityHeaders(response: Response): Response {
  // Response headers from the SSR handler are mutable in Bun/undici.
  for (const [key, value] of Object.entries(securityHeaders)) {
    if (!response.headers.has(key)) response.headers.set(key, value)
  }
  return response
}

// @ts-ignore - Bun global
const server = Bun.serve({
  port,
  hostname: '0.0.0.0',
  async fetch(request: Request, server: any) {
    const url = new URL(request.url)
    const pathname = url.pathname

    // Handle WebSocket upgrade. The session is resolved here and attached as
    // `data` — without it ws.data is undefined, nothing subscribes to
    // `user:<id>`, and every server-side broadcast goes to an empty topic.
    if (pathname === '/ws') {
      const auth = await authorizeWs(url.origin, withClientIp(request, server).headers)
      if (!auth.authenticated) {
        return new Response('Unauthorized', { status: 401 })
      }
      // Keep the cookie so event subscriptions can be re-authorized later
      // against a live session rather than a userId captured at connect time.
      const upgraded = server.upgrade(request, {
        data: { userId: auth.userId, cookie: request.headers.get('cookie') ?? '' },
      })
      if (upgraded) {
        return undefined // Connection upgraded to WebSocket
      }
      return new Response('WebSocket upgrade failed', { status: 400 })
    }

    // Serve static assets from dist/client first
    const staticPath = resolveStaticPath(pathname)
    if (staticPath) {
      try {
        const stats = await stat(staticPath)
        if (stats.isFile()) {
          const file = Bun.file(staticPath)
          return new Response(file, {
            headers: {
              ...securityHeaders,
              'Content-Type': getMimeType(pathname),
              'Cache-Control': pathname.startsWith('/assets/')
                ? 'public, max-age=31536000, immutable'
                : 'public, max-age=3600',
            },
          })
        }
      } catch {
        // Not a static file — fall through to SSR
      }
    }

    const response = await serverEntry.fetch(withClientIp(request, server))
    return withSecurityHeaders(response)
  },
  websocket: {
    async open(ws: any) {
      const userId = ws.data?.userId
      if (!userId) {
        ws.close(1008, 'Unauthorized')
        return
      }
      ws.subscribe(`user:${userId}`)
    },
    async message(ws: any, message: string | Buffer) {
      try {
        const data = typeof message === 'string' ? message : message.toString()
        if (data.length > 8192) {
          throw new Error('Message too large')
        }
        const msg = JSON.parse(data)
        await handleWebSocketMessage(ws, msg)
      } catch (error) {
        console.error('WebSocket message error:', error)
        ws.send(JSON.stringify({
          type: 'error',
          payload: { message: 'Invalid message format' },
          timestamp: Date.now(),
        }))
      }
    },
    close(ws: any) {
      const userId = ws.data?.userId
      if (userId) {
        ws.unsubscribe(`user:${userId}`)
      }
    },
  },
  error(error: Error) {
    console.error('Server error:', error)
    return new Response('Internal Server Error', { status: 500 })
  },
})

// Initialize WebSocket broadcasting
;(globalThis as any).__bunServer__ = server

async function handleWebSocketMessage(ws: any, message: any) {
  const userId = ws.data?.userId
  if (!userId) return

  switch (message.type) {
    case 'subscribe_event': {
      // Membership check: previously any connected client could subscribe to
      // any event topic and stream a private event's post feed. Re-authorized
      // against the live session, so a revoked session loses access without
      // needing the socket to reconnect.
      if (typeof message.eventId !== 'string' || !message.eventId) break
      const auth = await authorizeWs(
        publicOrigin,
        new Headers({ cookie: ws.data?.cookie ?? '' }),
        message.eventId,
      )
      if (!auth.authenticated || auth.userId !== userId || !auth.canSubscribe) {
        ws.send(JSON.stringify({
          type: 'error',
          payload: { message: 'Not authorized for this event' },
          timestamp: Date.now(),
        }))
        break
      }
      ws.subscribe(`event:${message.eventId}`)
      break
    }
    case 'unsubscribe_event':
      if (typeof message.eventId === 'string' && message.eventId) {
        ws.unsubscribe(`event:${message.eventId}`)
      }
      break
    case 'typing': {
      // Relay typing to the other participant. Nothing handled this before, so
      // the client's typing indicator was wired to a topic nobody published to.
      if (typeof message.chatId !== 'string' || !message.chatId) break
      const auth = await authorizeWs(
        publicOrigin,
        new Headers({ cookie: ws.data?.cookie ?? '' }),
        undefined,
        message.chatId,
      )
      const peerId = auth.authenticated && auth.userId === userId ? auth.peerId : null
      if (!peerId) break

      // Organizer chat ids embed the *peer's* user id, so the two sides of the
      // same conversation have different ids: A sees `org_<evt>_<B>` while B
      // sees `org_<evt>_<A>`. Publishing the sender's id meant the receiver's
      // `payload.chatId !== chatId` filter dropped every typing event. Rewrite
      // it into the receiver's own form. Match chats share one id, so they
      // pass through unchanged.
      let receiverChatId: string = message.chatId
      if (receiverChatId.startsWith('org_')) {
        const rest = receiverChatId.slice('org_'.length)
        const separator = rest.indexOf('_')
        if (separator > 0) {
          receiverChatId = `org_${rest.slice(0, separator)}_${userId}`
        }
      }

      server.publish(
        `user:${peerId}`,
        JSON.stringify({
          type: 'typing',
          payload: { chatId: receiverChatId, userId, isTyping: !!message.isTyping },
          timestamp: Date.now(),
        }),
      )
      break
    }
    case 'ping':
      ws.send(JSON.stringify({
        type: 'online_status',
        payload: { pong: true },
        timestamp: Date.now(),
      }))
      break
  }
}

// Drain in-flight requests before exiting, so a redeploy doesn't kill requests
// mid-query. server.stop() returns a promise that resolves once active
// connections have finished; awaiting it is the whole point — discarding it
// exits immediately and defeats the drain.
let shuttingDown = false
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`Received ${signal}, draining connections...`)

    // Backstop: never hang forever waiting on a stuck connection.
    const force = setTimeout(() => {
      console.warn('Drain timed out, exiting anyway.')
      process.exit(0)
    }, 15_000)
    force.unref?.()

    void Promise.resolve(server.stop(false))
      .catch((err: unknown) => console.error('Error during shutdown:', err))
      .finally(() => {
        clearTimeout(force)
        process.exit(0)
      })
  })
}

console.log(`Server running at http://0.0.0.0:${port}`)
