import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft, MapPin, Users, SlidersHorizontal, Globe, Calendar } from 'lucide-react'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Skeleton } from '@heroui/react'
import { getMyProfile, updateProfile } from '#/server/profiles'
import { getMyActiveEvent } from '#/server/events'

export const Route = createFileRoute('/settings/discovery')({ component: DiscoverySettingsPage })

function DiscoverySettingsPage() {
  const queryClient = useQueryClient()
  const [distance, setDistance] = useState(25)
  const [ageMin, setAgeMin] = useState(21)
  const [ageMax, setAgeMax] = useState(35)
  const [showMe, setShowMe] = useState('Everyone')

  const { data: profile, isLoading: profileLoading } = useQuery({
    queryKey: ['my-profile'],
    queryFn: () => getMyProfile(),
  })
  const { data: activeEvent } = useQuery({
    queryKey: ['active-event'],
    queryFn: () => getMyActiveEvent(),
  })

  const discoveryMode = profile?.discoveryMode ?? 'global'

  const setModeMutation = useMutation({
    mutationFn: (mode: 'global' | 'event') => updateProfile({ data: { discoveryMode: mode } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['my-profile'] })
      queryClient.invalidateQueries({ queryKey: ['swipe-deck'] })
    },
  })

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
            <MapPin className="h-4 w-4 text-[var(--mag-ink-soft)]" />
            <h2 className="text-sm font-semibold text-[var(--mag-ink)]">Maximum Distance</h2>
            <span className="ml-auto text-sm font-medium text-[var(--mag-ink)]">{distance} mi</span>
          </div>
          <input
            type="range"
            min={1}
            max={100}
            value={distance}
            onChange={(e) => setDistance(Number(e.target.value))}
            className="w-full accent-[#111111]"
          />
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
              max={80}
              value={ageMin}
              onChange={(e) => setAgeMin(Math.min(Number(e.target.value), ageMax))}
              className="w-full accent-[#111111]"
            />
            <input
              type="range"
              min={18}
              max={80}
              value={ageMax}
              onChange={(e) => setAgeMax(Math.max(Number(e.target.value), ageMin))}
              className="w-full accent-[#111111]"
            />
          </div>
        </div>

        <div className="rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-3">
          <div className="mb-3 flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-[var(--mag-ink-soft)]" />
            <h2 className="text-sm font-semibold text-[var(--mag-ink)]">Show Me</h2>
          </div>
          <div className="flex flex-wrap gap-2">
            {['Women', 'Men', 'Everyone'].map((option) => (
              <button
                key={option}
                onClick={() => setShowMe(option)}
                className={`rounded-full px-4 py-2 text-xs font-medium transition ${
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
      </div>
    </main>
  )
}
