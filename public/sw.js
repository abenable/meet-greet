/* eslint-disable no-restricted-globals */
/**
 * Meet & Greet service worker.
 *
 * History worth knowing: vite.config.ts used to configure VitePWA with a
 * precache manifest and four runtimeCaching rules, none of which ever ran —
 * this file was copied verbatim into dist/client and overwrote the generated
 * worker. The plugin's injectManifest mode does not emit under TanStack Start's
 * multi-environment build, so rather than leave dead configuration in place,
 * this is now the one and only worker and the plugin has been removed.
 *
 * Deliberately NOT cached: anything under /api/ or /_serverFn/. The previous
 * config had a NetworkFirst rule over /api/* writing into a shared,
 * origin-scoped cache — on a shared device that serves one user's data to the
 * next.
 */

const CACHE_VERSION = 'mag-v1'
const ASSET_CACHE = `${CACHE_VERSION}-assets`

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from previous versions.
      const keys = await caches.keys()
      await Promise.all(
        keys.filter((key) => !key.startsWith(CACHE_VERSION)).map((key) => caches.delete(key)),
      )
      await self.clients.claim()
    })(),
  )
})

/** Content-hashed build output and static icons — safe to cache immutably. */
function isCacheableAsset(url) {
  if (url.origin !== self.location.origin) return false
  if (url.pathname.startsWith('/api/')) return false
  if (url.pathname.startsWith('/_serverFn/')) return false
  return (
    url.pathname.startsWith('/assets/') ||
    /\.(?:css|js|woff2?|png|jpg|jpeg|svg|gif|webp|ico)$/i.test(url.pathname)
  )
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  let url
  try {
    url = new URL(request.url)
  } catch {
    return
  }

  if (!isCacheableAsset(url)) return

  event.respondWith(
    (async () => {
      const cache = await caches.open(ASSET_CACHE)
      const cached = await cache.match(request)
      if (cached) return cached

      const response = await fetch(request)
      // Only store complete, same-origin successes — never opaque responses,
      // which can silently cache an error page forever.
      if (response.ok && response.type === 'basic') {
        cache.put(request, response.clone()).catch(() => {})
      }
      return response
    })(),
  )
})

self.addEventListener('push', (event) => {
  if (!event.data) return

  let data = {}
  try {
    data = event.data.json()
  } catch {
    data = { title: event.data.text() }
  }

  const title = data.title || 'Meet & Greet'
  const options = {
    body: data.body || '',
    icon: data.icon || '/logo192.png',
    badge: data.badge || '/logo192.png',
    data: { url: data.url || '/' },
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url || '/'

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        const target = new URL(url, self.location.origin)
        for (const client of clientList) {
          // Compare paths, not full URLs, so a notification for /chats/x
          // focuses a tab already on that route.
          try {
            if (new URL(client.url).pathname === target.pathname && 'focus' in client) {
              return client.focus()
            }
          } catch {
            // Ignore unparseable client URLs.
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(url)
        }
      }),
  )
})
