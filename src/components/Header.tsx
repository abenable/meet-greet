import { Link, useRouterState, getRouteApi } from '@tanstack/react-router'
import { Moon, Sun, Bell, Shield } from 'lucide-react'
import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getUnreadNotificationCount } from '#/server/notifications'
import Logo from './Logo'
import AvatarImage from './AvatarImage'

const rootRoute = getRouteApi('__root__')

export default function Header() {
  const router = useRouterState()
  const path = router.location.pathname
  const [dark, setDark] = useState(false)
  const { session } = rootRoute.useRouteContext()
  const { data: unreadCount = 0 } = useQuery({
    queryKey: ['unread-notifications'],
    queryFn: () => getUnreadNotificationCount(),
    enabled: !!session?.user,
    refetchInterval: 30000,
  })

  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'))
  }, [])

  const hideHeaderPaths = ['/login', '/signup', '/forgot-password']
  const isAuthScreen = hideHeaderPaths.some((p) => path === p || path.startsWith(p + '/'))
  if (isAuthScreen) return null

  const toggle = () => {
    const next = !dark
    setDark(next)
    if (next) {
      document.documentElement.classList.add('dark')
      localStorage.setItem('mag-theme', 'dark')
    } else {
      document.documentElement.classList.remove('dark')
      localStorage.setItem('mag-theme', 'light')
    }
  }

  return (
    <header className="sticky top-0 z-50 border-b border-[var(--mag-line)] bg-[var(--header-bg)] backdrop-blur-lg">
      <div className="page-wrap flex items-center justify-between py-3">
        <Link to="/" className="flex items-center gap-1.5 no-underline">
          <Logo className="h-6 w-auto" />
          <span className="text-base font-medium tracking-normal text-[var(--mag-ink)]">Meet & Greet</span>
        </Link>
        <div className="flex items-center gap-1">
          {session?.user && (
            <Link
              to="/notifications"
              className="relative flex h-10 w-10 items-center justify-center rounded-full text-[var(--mag-ink-soft)] transition hover:bg-[var(--mag-surface)]"
            >
              <Bell className="h-5 w-5" />
              {unreadCount > 0 && (
                <span className="absolute top-0 right-0 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[var(--mag-sale)] px-1 text-[10px] font-bold text-[var(--mag-bg)]">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </Link>
          )}
          {session?.user?.role === 'admin' && (
            <Link
              to="/admin"
              className="relative flex h-10 w-10 items-center justify-center rounded-full text-[var(--mag-ink-soft)] transition hover:bg-[var(--mag-surface)]"
            >
              <Shield className="h-5 w-5" />
            </Link>
          )}
          <button
            onClick={toggle}
            className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--mag-ink-soft)] transition hover:bg-[var(--mag-surface)]"
            aria-label="Toggle theme"
          >
            {dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </button>
          {session?.user ? (
            <Link
              to="/profile"
              className="relative flex h-10 w-10 items-center justify-center overflow-hidden rounded-full bg-[var(--mag-surface)] text-[var(--mag-ink-soft)]"
            >
              <AvatarImage src={session.user.image} />
            </Link>
          ) : null}
        </div>
      </div>
    </header>
  )
}
