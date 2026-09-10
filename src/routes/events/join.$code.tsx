import { createFileRoute, useNavigate, useParams } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Users,
  MapPin,
  LogIn,
  Loader2,
  Clock,
  ListOrdered,
} from 'lucide-react'
import { getEventByCode, joinEvent } from '#/server/events'

export const Route = createFileRoute('/events/join/$code')({
  component: ShareJoinPage,
})

function ShareJoinPage() {
  const { code } = useParams({ from: '/events/join/$code' })
  const navigate = useNavigate()
  const [status, setStatus] = useState<'loading' | 'ready' | 'joining' | 'success' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const [alreadyJoined, setAlreadyJoined] = useState(false)
  const [waitlisted, setWaitlisted] = useState(false)
  const [confirmInfo, setConfirmInfo] = useState<{ currentEventName: string; eventName: string } | null>(null)

  // Read the session off the root route's context rather than issuing a
  // second, independent getSession() call. The root beforeLoad has already
  // resolved it once for this navigation (including the "lookup failed, don't
  // assume signed-out" handling in __root.tsx) — refetching here duplicated
  // the round trip and, worse, had its own cruder redirect-on-any-falsy-value
  // logic that didn't share that safety: a session that failed to resolve for
  // any transient reason read the same as a confirmed sign-out and bounced
  // straight to /login, discarding whatever the visitor was doing here.
  const { session } = Route.useRouteContext()

  const { data: event, isLoading: eventLoading } = useQuery({
    queryKey: ['event-by-code', code],
    queryFn: () => getEventByCode({ data: code }),
  })

  useEffect(() => {
    if (eventLoading) return

    if (!session?.user) {
      setStatus('error')
      setMessage('Log in to join this event.')
      return
    }

    if (!event) {
      setStatus('error')
      setMessage('Event not found or not currently open for joining.')
      return
    }

    setStatus('ready')
  }, [session, event, eventLoading])

  const doJoin = async (force = false) => {
    setStatus('joining')
    try {
      const result = await joinEvent({ data: { code, force } })
      if (result.success) {
        setAlreadyJoined((result as any).alreadyJoined === true)
        setWaitlisted((result as any).waitlisted === true)
        setStatus('success')
        setTimeout(() => navigate({ to: '/events' }), 1800)
      } else if ((result as any).needsConfirm) {
        setStatus('ready')
        setConfirmInfo({
          currentEventName: (result as any).currentEvent.name,
          eventName: (result as any).eventName,
        })
      } else {
        setStatus('error')
        setMessage(result.message || 'Could not join event.')
      }
    } catch {
      setStatus('error')
      setMessage('Something went wrong. Please try again.')
    }
  }

  return (
    <main className="page-wrap px-4 py-4">
      <div className="mb-5 flex items-center gap-2">
        <button
          onClick={() => navigate({ to: '/events' })}
          className="rounded-full p-2 text-[var(--mag-ink-soft)] transition hover:bg-[var(--mag-surface)]"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-lg font-bold text-[var(--mag-ink)]">Join Event</h1>
      </div>

      {status === 'loading' || status === 'joining' ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Loader2 className="mb-3 h-8 w-8 animate-spin text-[var(--mag-ink)]" />
          <p className="text-sm text-[var(--mag-ink-soft)]">
            {status === 'joining' ? 'Joining…' : 'Loading…'}
          </p>
        </div>
      ) : status === 'success' ? (
        <div className="rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-5 text-center">
          <CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-[var(--mag-ink)]" />
          <h2 className="text-lg font-bold text-[var(--mag-ink)]">
            {alreadyJoined ? 'You are already in!' : waitlisted ? 'You are on the waitlist!' : 'You are in!'}
          </h2>
          <p className="mt-1 text-sm text-[var(--mag-ink-soft)]">
            {waitlisted
              ? `${event?.name} — You will automatically join when the event starts.`
              : `${event?.name} — redirecting…`}
          </p>
        </div>
      ) : status === 'error' ? (
        <div className="space-y-3">
          {event && (
            <div className="rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-3">
              <div className="flex items-start gap-3">
                {(event as any).photo && (
                  <img src={(event as any).photo} alt={event.name} className="h-20 w-20 shrink-0 rounded-xl object-cover" />
                )}
                <div className="min-w-0 flex-1">
                  <h2 className="text-base font-bold text-[var(--mag-ink)]">
                    {event.name}
                  </h2>
                  <p className="mt-0.5 text-xs text-[var(--mag-ink-soft)]">
                    {event.description}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-[var(--mag-ink-muted)]">
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="h-3 w-3" />
                      {event.location}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Users className="h-3 w-3" />
                      {(event as any)._count?.attendees ?? 0} attending
                    </span>
                    {event.startsAt && new Date(event.startsAt) > new Date() && (
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        Starts {new Date(event.startsAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="rounded-2xl border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-900/10">
            <div className="flex items-center gap-3">
              <XCircle className="h-6 w-6 shrink-0 text-[var(--mag-sale)]" />
              <div>
                <h3 className="text-sm font-semibold text-red-600 dark:text-red-400">
                  Could not join
                </h3>
                <p className="text-xs text-[var(--mag-sale)] dark:text-red-400/80">
                  {message}
                </p>
              </div>
            </div>
          </div>

          {!session?.user && (
            <button
              onClick={() =>
                navigate({
                  to: '/login',
                  search: { redirect: `/events/join/${code}` },
                })
              }
              className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-[var(--mag-ink)] py-3 text-sm font-bold !text-[var(--mag-bg)] transition hover:opacity-80"
            >
              <LogIn className="h-4 w-4" />
              Log in to Join
            </button>
          )}

          <button
            onClick={() => navigate({ to: '/events' })}
            className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-[var(--mag-line)] bg-[var(--mag-card)] py-3 text-sm font-medium text-[var(--mag-ink)] transition hover:bg-[var(--mag-surface)]"
          >
            Browse Events
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {event && (
            <div className="rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-3">
              <div className="flex items-start gap-3">
                {(event as any).photo && (
                  <img src={(event as any).photo} alt={event.name} className="h-20 w-20 shrink-0 rounded-xl object-cover" />
                )}
                <div className="min-w-0 flex-1">
                  <h2 className="text-base font-bold text-[var(--mag-ink)]">
                    {event.name}
                  </h2>
                  <p className="mt-0.5 text-xs text-[var(--mag-ink-soft)]">
                    {event.description}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-[var(--mag-ink-muted)]">
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="h-3 w-3" />
                      {event.location}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Users className="h-3 w-3" />
                      {(event as any)._count?.attendees ?? 0} attending
                    </span>
                    {event.startsAt && new Date(event.startsAt) > new Date() && (
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        Starts {new Date(event.startsAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {confirmInfo ? (
            <div className="rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-3">
              <h3 className="mb-2 text-sm font-bold text-[var(--mag-ink)]">Leave current event?</h3>
              <p className="mb-4 text-xs text-[var(--mag-ink-soft)]">
                You are already checked into <strong className="text-[var(--mag-ink)]">{confirmInfo.currentEventName}</strong>. You can only be in one event at a time.
              </p>
              <p className="mb-4 text-xs text-[var(--mag-ink-soft)]">
                Join <strong className="text-[var(--mag-ink)]">{confirmInfo.eventName}</strong> anyway?
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => { setConfirmInfo(null); navigate({ to: '/events' }) }}
                  className="flex-1 rounded-full border border-[var(--mag-line)] bg-[var(--mag-card)] py-2.5 text-sm font-medium text-[var(--mag-ink)] transition hover:bg-[var(--mag-surface)]"
                >
                  Cancel
                </button>
                <button
                  onClick={() => doJoin(true)}
                  className="flex-1 rounded-full bg-[var(--mag-ink)] py-2.5 text-sm font-bold text-[var(--mag-bg)] transition hover:opacity-80"
                >
                  Switch Event
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => doJoin()}
              className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-[var(--mag-ink)] py-3 text-sm font-bold !text-[var(--mag-bg)] transition hover:opacity-80"
            >
              {event && event.startsAt && new Date(event.startsAt) > new Date() ? (
                <>
                  <ListOrdered className="h-4 w-4" />
                  Join Waitlist
                </>
              ) : (
                <>
                  <LogIn className="h-4 w-4" />
                  Join Event
                </>
              )}
            </button>
          )}
        </div>
      )}
    </main>
  )
}
