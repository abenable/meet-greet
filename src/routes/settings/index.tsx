import { createFileRoute, Link } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Skeleton } from '@heroui/react'
import {
  Compass,
  Bell,
  Shield,
  UserCog,
  ChevronRight,
  Moon,
  HelpCircle,
  Info,
  X,
  Sun,
  Ban,
  Zap,
} from 'lucide-react'
import { getBoostStatus } from '#/server/boosts'

export const Route = createFileRoute('/settings/')({ component: SettingsPage })

function SettingsPage() {
  const [darkMode, setDarkMode] = useState(false)
  const [showHelp, setShowHelp] = useState(false)

  const { data: boostStatus, isLoading: boostLoading } = useQuery({
    queryKey: ['boost-status'],
    queryFn: () => getBoostStatus(),
  })

  useEffect(() => {
    const isDark = document.documentElement.classList.contains('dark')
    setDarkMode(isDark)
  }, [])

  const handleToggleDark = () => {
    const next = !darkMode
    setDarkMode(next)
    if (next) {
      document.documentElement.classList.add('dark')
      localStorage.setItem('mag-theme', 'dark')
    } else {
      document.documentElement.classList.remove('dark')
      localStorage.setItem('mag-theme', 'light')
    }
  }

  const sections = [
    {
      title: 'Preferences',
      items: [
        { icon: Compass, label: 'Discovery Settings', to: '/settings/discovery' },
        { icon: Bell, label: 'Notifications', to: '/settings/notifications' },
      ],
    },
    {
      title: 'Safety & Privacy',
      items: [
        { icon: Shield, label: 'Privacy & Safety', to: '/settings/privacy' },
        { icon: Ban, label: 'Blocked Users', to: '/settings/blocked' },
        { icon: UserCog, label: 'Account Settings', to: '/settings/account' },
      ],
    },
    {
      title: 'App',
      items: [
        { icon: Info, label: 'About Meet & Greet', to: '/about' },
      ],
    },
  ]

  return (
    <main className="page-wrap px-4 py-4">
      <div className="mb-5 text-center">
        <h1 className="text-xl font-bold text-[var(--mag-ink)]">Settings</h1>
      </div>

      <div className="mx-auto max-w-md space-y-6">
        {/* Boosts */}
        <div>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--mag-ink-muted)]">
            Boosts
          </h2>
          {boostLoading ? (
            <div className="overflow-hidden rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-3 space-y-2">
              <Skeleton className="h-5 w-32 rounded-lg" />
              <Skeleton className="h-3 w-48 rounded-lg" />
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)]">
              <div className="flex items-center gap-3 px-3 py-3">
                <Zap className={`h-5 w-5 ${boostStatus?.isBoosted ? 'text-[var(--mag-ink)]' : 'text-[var(--mag-ink-soft)]'}`} />
                <div className="flex-1">
                  <p className="text-sm text-[var(--mag-ink)]">
                    {boostStatus?.isBoosted
                      ? 'Profile is boosted'
                      : boostStatus?.nextBoostAt
                        ? 'Boost on cooldown'
                        : 'Boost available'}
                  </p>
                  <p className="text-xs text-[var(--mag-ink-muted)]">
                    {boostStatus?.isBoosted
                      ? 'Your profile is shown first in the swipe deck'
                      : boostStatus?.nextBoostAt
                        ? `Next boost available soon`
                        : 'Use a boost to be shown first for 1 hour'}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        {sections.map((section) => (
          <div key={section.title}>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--mag-ink-muted)]">
              {section.title}
            </h2>
            <div className="overflow-hidden rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)]">
              {section.items.map((item, i) => (
                <Link
                  key={item.label}
                  to={item.to}
                  className={`flex items-center gap-3 px-3 py-3 transition hover:bg-[var(--mag-surface)] no-underline ${
                    i < section.items.length - 1 ? 'border-b border-[var(--mag-line)]' : ''
                  }`}
                >
                  <item.icon className="h-5 w-5 text-[var(--mag-ink-soft)]" />
                  <span className="flex-1 text-sm text-[var(--mag-ink)]">{item.label}</span>
                  <ChevronRight className="h-4 w-4 text-[var(--mag-ink-muted)]" />
                </Link>
              ))}
            </div>
          </div>
        ))}

        {/* Dark Mode Toggle */}
        <div>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--mag-ink-muted)]">
            Appearance
          </h2>
          <div className="overflow-hidden rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)]">
            <button
              onClick={handleToggleDark}
              className="flex w-full items-center gap-3 px-3 py-3 transition hover:bg-[var(--mag-surface)] text-left"
            >
              {darkMode ? (
                <Sun className="h-5 w-5 text-[var(--mag-ink-soft)]" />
              ) : (
                <Moon className="h-5 w-5 text-[var(--mag-ink-soft)]" />
              )}
              <span className="flex-1 text-sm text-[var(--mag-ink)]">{darkMode ? 'Light Mode' : 'Dark Mode'}</span>
              <span className={`relative h-6 w-11 rounded-full transition ${darkMode ? 'bg-[var(--mag-ink)]' : 'bg-[var(--mag-line)]'}`}>
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition ${darkMode ? 'left-[22px]' : 'left-0.5'}`} />
              </span>
            </button>
          </div>
        </div>

        {/* Help & Support */}
        <div>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--mag-ink-muted)]">
            Support
          </h2>
          <div className="overflow-hidden rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)]">
            <button
              onClick={() => setShowHelp(true)}
              className="flex w-full items-center gap-3 px-3 py-3 transition hover:bg-[var(--mag-surface)] text-left"
            >
              <HelpCircle className="h-5 w-5 text-[var(--mag-ink-soft)]" />
              <span className="flex-1 text-sm text-[var(--mag-ink)]">Help & Support</span>
              <ChevronRight className="h-4 w-4 text-[var(--mag-ink-muted)]" />
            </button>
          </div>
        </div>
      </div>

        <button
        onClick={() => alert('Logged out')}
        className="mt-8 block w-full max-w-xs mx-auto rounded-full border border-[var(--mag-sale)]/30 bg-[var(--mag-sale)]/10 py-3 text-sm font-semibold text-[var(--mag-sale)] transition hover:bg-[var(--mag-sale)]/20"
      >
        Log Out
      </button>

      <p className="mt-4 text-center text-[10px] text-[var(--mag-ink-muted)]">
        Meet &amp; Greet v1.0.0 &middot; Build 2026.04.29
      </p>

      {/* Help Modal */}
      {showHelp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-2xl bg-[var(--mag-card)] p-5 border border-[var(--mag-line)]">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[var(--mag-ink)]">Help &amp; Support</h3>
              <button onClick={() => setShowHelp(false)} className="rounded-full p-1 text-[var(--mag-ink-muted)] hover:bg-[var(--mag-surface)]">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3 text-sm text-[var(--mag-ink-soft)]">
              <p><strong className="text-[var(--mag-ink)]">Getting Started:</strong> Complete your profile and start discovering people.</p>
              <p><strong className="text-[var(--mag-ink)]">Safety:</strong> Use the Safety Center to report or block users.</p>
              <p><strong className="text-[var(--mag-ink)]">Contact:</strong> Email us at support@meetandgreet.app</p>
            </div>
            <button
              onClick={() => setShowHelp(false)}
              className="mt-4 w-full rounded-full bg-[var(--mag-ink)] py-2.5 text-sm font-semibold text-[var(--mag-bg)] transition hover:opacity-80"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </main>
  )
}
