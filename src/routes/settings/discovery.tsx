import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft, Users, SlidersHorizontal, Globe, Calendar, Check } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Skeleton } from '@heroui/react'
import { getMyProfile, updateProfile } from '#/server/profiles'
import { getMyActiveEvent } from '#/server/events'

export const Route = createFileRoute('/settings/discovery')({ component: DiscoverySettingsPage })

const SHOW_ME_OPTIONS = ['Women', 'Men', 'Everyone'] as const

function DiscoverySettingsPage() {
  const queryClient = useQueryClient()
  const [ageMin, setAgeMin] = useState(18)
  const [ageMax, setAgeMax] = useState(99)
  const [savedJustNow, setSavedJustNow] = useState(false)

  const { data: profile, isLoading: profileLoading } = useQuery({
    queryKey: ['my-profile'],
    queryFn: () => getMyProfile(),
  })
  const { data: activeEvent } = useQuery({
    queryKey: ['active-event'],
    queryFn: () => getMyActiveEvent(),
  })

  useEffect(() => {
    if (!profile) return
    setAgeMin(profile.prefAgeMin)
    setAgeMax(profile.prefAgeMax)
  }, [profile])

  const discoveryMode = profile?.discoveryMode ?? 'global'
  const showMe = profile?.prefShowMe ?? 'Everyone'

  const invalidateAfterSave = () => {
    queryClient.invalidateQueries({ queryKey: ['my-profile'] })
    queryClient.invalidateQueries({ queryKey: ['swipe-deck'] })
    setSavedJustNow(true)
    setTimeout(() => setSavedJustNow(false), 1500)
  }

  const setModeMutation = useMutation({
    mutationFn: (mode: 'global' | 'event') => updateProfile({ data: { discoveryMode: mode } }),
    onSuccess: invalidateAfterSave,
  })

  const setShowMeMutation = useMutation({
    mutationFn: (value: (typeof SHOW_ME_OPTIONS)[number]) => updateProfile({ data: { prefShowMe: value } }),
    onSuccess: invalidateAfterSave,
  })

  const setAgeRangeMutation = useMutation({
    mutationFn: (range: { prefAgeMin: number; prefAgeMax: number }) => updateProfile({ data: range }),
    onSuccess: invalidateAfterSave,
  })

  const commitAgeRange = () => {
    setAgeRangeMutation.mutate({ prefAgeMin: ageMin, prefAgeMax: ageMax })
  }

  return (
    <main className="page-wrap px-4 py-4">
      <div className="mb-4 flex items-center gap-2">
        <Link to="/settings" className="rounded-full p-2 text-[var(--mag-ink-soft)] hover:bg-[var(--mag-surface)] no-underline">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-lg font-bold text-[var(--mag-ink)]">Discovery Settings</h1>
      </div>

      <div className="mx-auto max-w-md space-y-5">
        <div className="rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-3">
          <h2 className="mb-3 text-sm font-semibold text-[var(--mag-ink)]">Discovery Pool</h2>
          {profileLoading ? (
            <Skeleton className="h-16 w-full rounded-xl" />
          ) : (
            <div className="space-y-2">
              <button
                onClick={() => setModeMutation.mutate('global')}
                disabled={setModeMutation.isPending}
                className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition disabled:opacity-60 ${
                  discoveryMode === 'global'
                    ? 'border-[var(--mag-ink)] bg-[var(--mag-surface)]'
                    : 'border-[var(--mag-line)]'
                }`}
              >
                <Globe className="mt-0.5 h-4 w-4 shrink-0 text-[var(--mag-ink-soft)]" />
                <div>
                  <p className="text-sm font-medium text-[var(--mag-ink)]">Global</p>
                  <p className="text-xs text-[var(--mag-ink-muted)]">
                    Be discoverable to everyone on the app, no event check-in required. Default.
                  </p>
                </div>
              </button>
              <button
                onClick={() => setModeMutation.mutate('event')}
                disabled={setModeMutation.isPending}
                className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition disabled:opacity-60 ${
                  discoveryMode === 'event'
                    ? 'border-[var(--mag-ink)] bg-[var(--mag-surface)]'
                    : 'border-[var(--mag-line)]'
                }`}
              >
                <Calendar className="mt-0.5 h-4 w-4 shrink-0 text-[var(--mag-ink-soft)]" />
                <div>
                  <p className="text-sm font-medium text-[var(--mag-ink)]">This Event</p>
                  <p className="text-xs text-[var(--mag-ink-muted)]">
                    {activeEvent
                      ? `Only discoverable by attendees of ${activeEvent.name}. You won't appear in the global pool.`
                      : "Only discoverable within an event you've checked into. You won't appear in the global pool. Join an event to use this."}
                  </p>
                </div>
              </button>
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-3">
          <div className="mb-3 flex items-center gap-2">
            <Users className="h-4 w-4 text-[var(--mag-ink-soft)]" />
            <h2 className="text-sm font-semibold text-[var(--mag-ink)]">Age Range</h2>
            <span className="ml-auto text-sm font-medium text-[var(--mag-ink)]">{ageMin} - {ageMax}</span>
          </div>
          <div className="flex gap-4">
            <input
              type="range"
              min={18}
              max={99}
              value={ageMin}
              onChange={(e) => setAgeMin(Math.min(Number(e.target.value), ageMax))}
              onMouseUp={commitAgeRange}
              onTouchEnd={commitAgeRange}
              onKeyUp={commitAgeRange}
              className="w-full accent-[#111111]"
            />
            <input
              type="range"
              min={18}
              max={99}
              value={ageMax}
              onChange={(e) => setAgeMax(Math.max(Number(e.target.value), ageMin))}
              onMouseUp={commitAgeRange}
              onTouchEnd={commitAgeRange}
              onKeyUp={commitAgeRange}
              className="w-full accent-[#111111]"
            />
          </div>
          <p className="mt-2 text-[10px] text-[var(--mag-ink-muted)]">
            People outside this range won't show up in your deck. Profiles without a birthday are always shown.
          </p>
        </div>

        <div className="rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-3">
          <div className="mb-3 flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-[var(--mag-ink-soft)]" />
            <h2 className="text-sm font-semibold text-[var(--mag-ink)]">Show Me</h2>
          </div>
          <div className="flex flex-wrap gap-2">
            {SHOW_ME_OPTIONS.map((option) => (
              <button
                key={option}
                onClick={() => setShowMeMutation.mutate(option)}
                disabled={setShowMeMutation.isPending}
                className={`rounded-full px-4 py-2 text-xs font-medium transition disabled:opacity-60 ${
                  showMe === option
                    ? 'bg-[var(--mag-ink)] text-[var(--mag-bg)]'
                    : 'border border-[var(--mag-line)] bg-[var(--mag-card)] text-[var(--mag-ink)]'
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>

        {savedJustNow && (
          <p className="flex items-center justify-center gap-1.5 text-xs font-medium text-[var(--mag-success)]">
            <Check className="h-3.5 w-3.5" /> Saved
          </p>
        )}
      </div>
    </main>
  )
}
