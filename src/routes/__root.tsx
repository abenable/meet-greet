import { HeadContent, Outlet, Scripts, createRootRouteWithContext, redirect } from '@tanstack/react-router'
import { useEffect } from 'react'
import Footer from '../components/Footer'
import Header from '../components/Header'
import BottomNav from '../components/BottomNav'
import PWAInstallPrompt from '../components/PWAInstallPrompt'
import { WebSocketProvider } from '../integrations/websocket/WebSocketProvider'
import { getVapidPublicKey, subscribePush } from '#/server/notifications'
import { checkAndUpdateStreak } from '#/server/badges'
import { pingPresence } from '#/server/presence'

import appCss from '../styles.css?url'

import type { QueryClient } from '@tanstack/react-query'
import { getSession } from '#/server/auth'

interface MyRouterContext {
  queryClient: QueryClient
  session?: Awaited<ReturnType<typeof getSession>>
}

const PUBLIC_PATHS = ['/', '/login', '/signup', '/forgot-password', '/about', '/api', '/events/join']

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + '/')
  )
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=0',
      },
      { title: 'Meet & Greet' },
      { name: 'description', content: 'Meet & Greet - Connect with people' },
      { name: 'theme-color', content: '#111111' },
      { name: 'mobile-web-app-capable', content: 'yes' },
      { name: 'apple-mobile-web-app-capable', content: 'yes' },
      { name: 'apple-mobile-web-app-status-bar-style', content: 'default' },
      { name: 'apple-mobile-web-app-title', content: 'Meet & Greet' },
    ],
    links: [
      {
        rel: 'icon',
        type: 'image/png',
        href: '/favicon.png',
      },
      {
        rel: 'alternate icon',
        href: '/favicon.ico',
      },
      {
        rel: 'apple-touch-icon',
        href: '/apple-touch-icon.png',
      },
      {
        rel: 'manifest',
        href: '/manifest.json',
      },
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),
  beforeLoad: async ({ location }) => {
    const isPublic = isPublicPath(location.pathname)

    let session: Awaited<ReturnType<typeof getSession>> = null
    try {
      session = await getSession()
    } catch {
      // If session fetch fails, treat as unauthenticated
    }

    if (isPublic) {
      if (session?.session && location.pathname === '/') {
        throw redirect({ to: '/discover' })
      }
      return { session }
    }

    if (!session?.session) {
      throw redirect({ to: '/login' })
    }

    return { session }
  },
  component: RootLayout,
  shellComponent: RootDocument,
  notFoundComponent: () => (
    <div className="flex flex-1 items-center justify-center">
      <p className="text-lg text-[var(--mag-ink-soft)]">Page not found</p>
    </div>
  ),
})

function RootLayout() {
  const { session } = Route.useRouteContext()

  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return

    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register('/sw.js')
        console.log('[SW] Registered:', registration.scope)
      } catch (error) {
        console.error('[SW] Registration failed:', error)
      }
    }

    void register()
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
    if (!session?.user) return

    const setupPush = async () => {
      try {
        const registration = await navigator.serviceWorker.ready

        const permission = await Notification.requestPermission()
        if (permission !== 'granted') return

        const publicKey = await getVapidPublicKey()
        if (!publicKey) return

        const existingSubscription = await registration.pushManager.getSubscription()
        if (existingSubscription) return

        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: publicKey,
        })

        const subJson = subscription.toJSON()
        if (!subJson.endpoint || !subJson.keys?.p256dh || !subJson.keys?.auth) return

        await subscribePush({
          data: {
            endpoint: subJson.endpoint,
            p256dh: subJson.keys.p256dh,
            auth: subJson.keys.auth,
          },
        })
      } catch (error) {
        console.error('[Push] Setup failed:', error)
      }
    }

    void setupPush()
  }, [session?.user])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!session?.user) return

    const lastCheck = localStorage.getItem('mag-last-streak-check')
    const today = new Date().toISOString().slice(0, 10)
    if (lastCheck === today) return

    const run = async () => {
      try {
        await checkAndUpdateStreak()
        localStorage.setItem('mag-last-streak-check', today)
      } catch (err) {
        console.error('[Streak] Check failed:', err)
      }
    }
    void run()
  }, [session?.user])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!session?.user) return

    const ping = () => {
      pingPresence().catch(() => {})
    }
    ping()
    const interval = setInterval(ping, 60 * 1000)
    return () => clearInterval(interval)
  }, [session?.user])

  return (
    <WebSocketProvider>
      <Header />
      <main className="flex flex-1 flex-col bg-[var(--mag-bg)]">
        <Outlet />
      </main>
      <Footer />
      <BottomNav />
      <PWAInstallPrompt />
    </WebSocketProvider>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('mag-theme')||'light';if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark');}catch(e){}})()`,
          }}
        />
      </head>
      <body className="font-sans antialiased flex flex-col min-h-[100dvh]">
        {children}
        <Scripts />
      </body>
    </html>
  )
}
