import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Skeleton } from '@heroui/react'
import { Calendar, MapPin, Plus, ArrowRight, Users, Clock, History, LogIn, ListOrdered, X, Star } from 'lucide-react'
import { listEvents, getMyActiveEvent, leaveEvent, joinEvent, getMyWaitlistedEvents, removeFromWaitlist } from '#/server/events'
import { getSession } from '#/server/auth'

export const Route = createFileRoute('/events/')({ component: EventsExplorePage })

function EventsExplorePage() {
  const queryClient = useQueryClient()

  const { data: eventsData, isLoading: eventsLoading } = useQuery({
    queryKey: ['events'],
    queryFn: () => listEvents(),
  })
  const events = eventsData?.items ?? []

  const { data: activeEvent, isLoading: activeEventLoading } = useQuery({
    queryKey: ['active-event'],
    queryFn: () => getMyActiveEvent(),
  })

  const { data: session, isLoading: sessionLoading } = useQuery({
    queryKey: ['session'],
    queryFn: () => getSession(),
  })

  const { data: waitlistedEvents = [] } = useQuery({
    queryKey: ['my-waitlisted-events'],
    queryFn: () => getMyWaitlistedEvents(),
  })

  const isLoading = eventsLoading || activeEventLoading || sessionLoading

  const [confirmModal, setConfirmModal] = useState<{ open: boolean; eventName: string; code: string; currentEventName: string } | null>(null)
  const [joinCodeModal, setJoinCodeModal] = useState<{ open: boolean; eventName: string } | null>(null)
  const [enteredCode, setEnteredCode] = useState('')
  const [joinError, setJoinError] = useState('')
  const [joinSuccess, setJoinSuccess] = useState('')

  const handleLeave = async () => {
    if (!activeEvent) return
    await leaveEvent({ data: activeEvent.id })
    queryClient.invalidateQueries({ queryKey: ['active-event'] })
  }

  const handleLeaveWaitlist = async (eventId: string) => {
    await removeFromWaitlist({ data: { eventId } })
    queryClient.invalidateQueries({ queryKey: ['my-waitlisted-events'] })
  }

  const handleJoin = async (code: string, force = false) => {
    setJoinError('')
    setJoinSuccess('')
    const result = await joinEvent({ data: { code, force } })
    if (result.success) {
      if ((result as any).waitlisted) {
        setJoinSuccess('You are on the waitlist! You will be added automatically when the event starts.')
        queryClient.invalidateQueries({ queryKey: ['my-waitlisted-events'] })
        queryClient.invalidateQueries({ queryKey: ['events'] })
      } else {
        setJoinCodeModal(null)
        setConfirmModal(null)
        queryClient.invalidateQueries({ queryKey: ['active-event'] })
        queryClient.invalidateQueries({ queryKey: ['my-waitlisted-events'] })
        queryClient.invalidateQueries({ queryKey: ['events'] })
      }
    } else if ((result as any).needsConfirm) {
      setJoinCodeModal(null)
      setJoinError('')
      setJoinSuccess('')
      setConfirmModal({
        open: true,
        eventName: (result as any).eventName,
        code,
        currentEventName: (result as any).currentEvent.name,
      })
    } else {
      setJoinError(result.message || 'Could not join event.')
    }
  }

  const confirmJoin = async () => {
    if (!confirmModal) return
    await handleJoin(confirmModal.code, true)
  }

  const now = Date.now()
  const currentEvents = (events as any[]).filter((e) => e.isActive && !e.endedAt && (!e.startsAt || new Date(e.startsAt).getTime() <= now))
  const upcomingEvents = (events as any[]).filter((e) => e.isActive && !e.endedAt && e.startsAt && new Date(e.startsAt).getTime() > now)
  const pastEvents = (events as any[]).filter((e) => e.endedAt)

  const attendeeCount = (activeEvent as any)?._count?.attendees ?? 0
  const hasJoinableEvents = currentEvents.length > 0 || upcomingEvents.length > 0

  return (
    <div className="page-wrap flex flex-1 flex-col px-4 py-4">
      <h1 className="mb-6 text-sm font-medium uppercase tracking-wide text-[var(--mag-ink-muted)]">Explore Events</h1>

      {isLoading ? (
        <div className="space-y-6">
          <div className="rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)]">
            <Skeleton className="h-40 w-full rounded-t-2xl" />
            <div className="p-3 space-y-2">
              <Skeleton className="h-5 w-1/2 rounded-lg" />
              <Skeleton className="h-3 w-full rounded-lg" />
              <div className="flex gap-2 pt-2">
                <Skeleton className="h-10 flex-1 rounded-full" />
                <Skeleton className="h-10 w-20 rounded-full" />
              </div>
            </div>
          </div>
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <div key={i} className="rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-3">
                <div className="flex items-start gap-3">
                  <Skeleton className="h-16 w-16 shrink-0 rounded-xl" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="h-4 w-3/4 rounded-lg" />
                    <Skeleton className="h-3 w-full rounded-lg" />
                    <div className="flex gap-2">
                      <Skeleton className="h-3 w-16 rounded-lg" />
                      <Skeleton className="h-3 w-20 rounded-lg" />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
          {/* Active Event Hero */}
          {activeEvent ? (
        <div className="mb-6 rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)]">
          <div className="relative">
            {activeEvent.photo ? (
              <div className="relative h-40 w-full overflow-hidden">
                <img src={activeEvent.photo} alt={activeEvent.name} className="h-full w-full object-cover" />
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
              </div>
            ) : (
              <div className="flex h-32 w-full items-center justify-center bg-[var(--mag-surface)]">
                <Calendar className="h-10 w-10 text-[var(--mag-ink-muted)]" />
              </div>
            )}
            <div className="absolute bottom-0 left-0 right-0 p-4">
              <span className="mb-1 inline-block rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-[var(--mag-ink)] uppercase tracking-wide">Active</span>
              <h2 className="text-xl font-bold text-white">{activeEvent.name}</h2>
            </div>
          </div>
          <div className="p-3">
            <p className="text-sm text-[var(--mag-ink-soft)]">{activeEvent.description}</p>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-[var(--mag-ink-muted)]">
              <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{activeEvent.location}</span>
              <span className="inline-flex items-center gap-1"><Users className="h-3.5 w-3.5" />{attendeeCount} people here</span>
              {activeEvent.createdById === session?.user?.id && (
                <span className="inline-flex items-center gap-1 rounded bg-[var(--mag-surface)] px-1.5 py-0.5 font-mono text-[10px] font-medium text-[var(--mag-ink-soft)]">Code: {activeEvent.code}</span>
              )}
            </div>
            <div className="mt-4 flex gap-2">
              <Link to="/discover" className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-full bg-[var(--mag-ink)] py-3 text-sm font-medium !text-[var(--mag-bg)] no-underline transition hover:opacity-80">
                Discover People <ArrowRight className="h-4 w-4" />
              </Link>
              {activeEvent.createdById === session?.user?.id && (
                <Link to="/events/manage/$eventId" params={{ eventId: activeEvent.id }} className="inline-flex items-center justify-center rounded-full border border-[var(--mag-line)] bg-[var(--mag-card)] px-5 py-3 text-sm font-medium text-[var(--mag-ink)] transition hover:bg-[var(--mag-surface)] no-underline">
                  Manage
                </Link>
              )}
              <button onClick={handleLeave} className="rounded-full border border-[var(--mag-line)] bg-[var(--mag-card)] px-5 py-3 text-sm font-medium text-[var(--mag-ink)] transition hover:bg-[var(--mag-surface)]">Leave</button>
            </div>
          </div>
        </div>
      ) : (
        <div className="mb-6 flex flex-col items-center rounded-2xl border border-dashed border-[var(--mag-line)] bg-[var(--mag-card)] py-10 text-center">
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--mag-surface)]">
            <Calendar className="h-7 w-7 text-[var(--mag-ink-muted)]" />
          </div>
          <h2 className="text-base font-bold text-[var(--mag-ink)]">No Active Event</h2>
          <p className="mt-1 max-w-[16rem] text-sm text-[var(--mag-ink-soft)]">
            {hasJoinableEvents
              ? 'Join a live event below to start meeting people nearby.'
              : 'There are no events right now. Create one to get started.'}
          </p>
          <div className="mt-4 flex gap-2">
            {hasJoinableEvents && (
              <button
                onClick={() => {
                  const el = document.getElementById('current-events')
                  el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }}
                className="inline-flex items-center gap-1.5 rounded-full bg-[var(--mag-ink)] px-5 py-2.5 text-sm font-medium text-[var(--mag-bg)] transition hover:opacity-80"
              >
                Browse Events <ArrowRight className="h-4 w-4" />
              </button>
            )}
            <Link
              to="/events/create"
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--mag-line)] bg-[var(--mag-card)] px-5 py-2.5 text-sm font-medium text-[var(--mag-ink)] transition hover:bg-[var(--mag-surface)] no-underline"
            >
              <Plus className="h-4 w-4" /> Create Event
            </Link>
          </div>
        </div>
      )}

      {/* Prominent Create CTA at top */}
      {activeEvent && (
        <Link to="/events/create" className="mb-8 flex items-center justify-center gap-2 rounded-full bg-[var(--mag-ink)] py-3.5 text-sm font-medium text-[var(--mag-bg)] transition hover:opacity-80 no-underline">
          <Plus className="h-4 w-4" /> Create New Event
        </Link>
      )}

      {/* Waitlisted */}
      {waitlistedEvents.length > 0 && (
        <section className="mb-8">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-bold text-[var(--mag-ink)]">Waitlisted</h3>
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--mag-surface)] px-2 py-0.5 text-[10px] font-medium text-[var(--mag-ink-muted)]"><ListOrdered className="h-3 w-3" />Waiting to start</span>
          </div>
          <div className="space-y-2">
            {waitlistedEvents.map((event) => {
              const count = (event as any)._count?.attendees ?? 0
              return (
                <div key={event.id} className="rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-3">
                  <div className="flex items-start gap-3">
                    {event.photo && (
                      <img src={event.photo} alt={event.name} className="h-16 w-16 shrink-0 rounded-xl object-cover" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-sm font-semibold text-[var(--mag-ink)]">{event.name}</h4>
                        <span className="shrink-0 rounded-full bg-[var(--mag-ink)] px-2 py-0.5 text-[10px] font-bold text-[var(--mag-bg)]">Waitlisted</span>
                      </div>
                      <p className="mt-0.5 text-xs text-[var(--mag-ink-soft)]">{event.description}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-[var(--mag-ink-muted)]">
                        <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{event.location}</span>
                        <span className="inline-flex items-center gap-1"><Users className="h-3 w-3" />{count} attending</span>
                        {event.startsAt && (
                          <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />Starts {new Date(event.startsAt).toLocaleString()}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => handleLeaveWaitlist(event.id)}
                      className="inline-flex items-center gap-1 rounded-full border border-[var(--mag-line)] bg-[var(--mag-card)] px-4 py-2 text-xs font-medium text-[var(--mag-ink)] transition hover:bg-[var(--mag-surface)]"
                    >
                      <X className="h-3 w-3" /> Leave Waitlist
                    </button>
                    <Link to="/events/waitlist/$eventId" params={{ eventId: event.id }} className="inline-flex items-center gap-1 rounded-full border border-[var(--mag-line)] bg-[var(--mag-card)] px-4 py-2 text-xs font-medium text-[var(--mag-ink)] transition hover:bg-[var(--mag-surface)] no-underline">
                      Waiting Room
                    </Link>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Current Events */}
      {currentEvents.length > 0 && (
        <section id="current-events" className="mb-8">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-bold text-[var(--mag-ink)]">Current Events</h3>
            <span className="rounded-full bg-[var(--mag-surface)] px-2 py-0.5 text-[10px] font-semibold text-[var(--mag-ink)] border border-[var(--mag-line)]">Live now</span>
          </div>
          <div className="space-y-2">
            {currentEvents.map((event) => {
              const count = (event as any)._count?.attendees ?? 0
              const isJoined = activeEvent?.id === event.id
              return (
                <div key={event.id} className="rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-3">
                  <div className="flex items-start gap-3">
                    {event.photo && (
                      <img src={event.photo} alt={event.name} className="h-16 w-16 shrink-0 rounded-xl object-cover" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-sm font-semibold text-[var(--mag-ink)]">{event.name}</h4>
                        {isJoined && <span className="shrink-0 rounded-full bg-[var(--mag-ink)] px-2 py-0.5 text-[10px] font-bold text-[var(--mag-bg)]">Joined</span>}
                        {(event as any).mysteryMode && (
                          <span className="shrink-0 rounded-full bg-[var(--mag-surface)] px-2 py-0.5 text-[10px] font-bold text-[var(--mag-ink)] border border-[var(--mag-line)]">Mystery</span>
                        )}
                        {(event as any).sponsorName && (
                          <span className="inline-flex items-center gap-1 shrink-0 rounded-full bg-[var(--mag-surface)] px-2 py-0.5 text-[10px] font-bold text-[var(--mag-ink)] border border-[var(--mag-line)]">
                            <Star className="h-3 w-3" /> Sponsored
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-[var(--mag-ink-soft)]">{event.description}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-[var(--mag-ink-muted)]">
                        <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{event.location}</span>
                        <span className="inline-flex items-center gap-1"><Users className="h-3 w-3" />{count} attending</span>
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex gap-2">
                    {!isJoined && (
                      <button
                        onClick={() => { setEnteredCode(''); setJoinError(''); setJoinCodeModal({ open: true, eventName: event.name }) }}
                        className="inline-flex flex-1 items-center justify-center gap-1 rounded-full bg-[var(--mag-ink)] px-4 py-2 text-xs font-bold text-[var(--mag-bg)] transition hover:opacity-80"
                      >
                        <LogIn className="h-3 w-3" /> Join
                      </button>
                    )}
                    {(event as any).createdById === session?.user?.id && (
                      <Link to="/events/manage/$eventId" params={{ eventId: event.id }} className="inline-flex flex-1 items-center justify-center gap-1 rounded-full border border-[var(--mag-line)] bg-[var(--mag-card)] px-4 py-2 text-xs font-medium text-[var(--mag-ink)] transition hover:bg-[var(--mag-surface)] no-underline">
                        Manage
                      </Link>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Upcoming Events */}
      {upcomingEvents.length > 0 && (
        <section className="mb-8">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-bold text-[var(--mag-ink)]">Upcoming Events</h3>
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--mag-surface)] px-2 py-0.5 text-[10px] font-medium text-[var(--mag-ink-muted)]"><Clock className="h-3 w-3" />Starting soon</span>
          </div>
          <div className="space-y-2">
            {upcomingEvents.map((event) => {
              const count = (event as any)._count?.attendees ?? 0
              return (
                <div key={event.id} className="rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-3 opacity-90">
                  <div className="flex items-start gap-3">
                    {event.photo && (
                      <img src={event.photo} alt={event.name} className="h-16 w-16 shrink-0 rounded-xl object-cover" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-sm font-semibold text-[var(--mag-ink)]">{event.name}</h4>
                        {(event as any).mysteryMode && (
                          <span className="shrink-0 rounded-full bg-[var(--mag-surface)] px-2 py-0.5 text-[10px] font-bold text-[var(--mag-ink)] border border-[var(--mag-line)]">Mystery</span>
                        )}
                        {(event as any).sponsorName && (
                          <span className="inline-flex items-center gap-1 shrink-0 rounded-full bg-[var(--mag-surface)] px-2 py-0.5 text-[10px] font-bold text-[var(--mag-ink)] border border-[var(--mag-line)]">
                            <Star className="h-3 w-3" /> Sponsored
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-[var(--mag-ink-soft)]">{event.description}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-[var(--mag-ink-muted)]">
                        <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{event.location}</span>
                        <span className="inline-flex items-center gap-1"><Users className="h-3 w-3" />{count} attending</span>
                        {event.startsAt && (
                          <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />Starts {new Date(event.startsAt).toLocaleString()}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => { setEnteredCode(''); setJoinError(''); setJoinSuccess(''); setJoinCodeModal({ open: true, eventName: event.name }) }}
                      className="inline-flex flex-1 items-center justify-center gap-1 rounded-full bg-[var(--mag-ink)] px-4 py-2 text-xs font-bold text-[var(--mag-bg)] transition hover:opacity-80"
                    >
                      <ListOrdered className="h-3 w-3" /> Join Waitlist
                    </button>
                    {(event as any).createdById === session?.user?.id && (
                      <Link to="/events/manage/$eventId" params={{ eventId: event.id }} className="inline-flex flex-1 items-center justify-center gap-1 rounded-full border border-[var(--mag-line)] bg-[var(--mag-card)] px-4 py-2 text-xs font-medium text-[var(--mag-ink)] transition hover:bg-[var(--mag-surface)] no-underline">
                        Manage
                      </Link>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* History */}
      {pastEvents.length > 0 && (
        <section className="mb-8">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-bold text-[var(--mag-ink)]">History</h3>
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--mag-surface)] px-2 py-0.5 text-[10px] font-medium text-[var(--mag-ink-muted)]"><History className="h-3 w-3" />Past events</span>
          </div>
          <div className="space-y-2">
            {pastEvents.map((event) => {
              const count = (event as any)._count?.attendees ?? 0
              return (
                <div key={event.id} className="rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-3 opacity-70">
                  <div className="flex items-start gap-3">
                    {event.photo && (
                      <img src={event.photo} alt={event.name} className="h-16 w-16 shrink-0 rounded-xl object-cover" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-sm font-semibold text-[var(--mag-ink)]">{event.name}</h4>
                        <span className="shrink-0 rounded-full bg-[var(--mag-ink-muted)]/10 px-2 py-0.5 text-[10px] font-bold text-[var(--mag-ink-muted)]">Ended</span>
                        {(event as any).sponsorName && (
                          <span className="inline-flex items-center gap-1 shrink-0 rounded-full bg-[var(--mag-surface)] px-2 py-0.5 text-[10px] font-bold text-[var(--mag-ink)] border border-[var(--mag-line)]">
                            <Star className="h-3 w-3" /> Sponsored
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-[var(--mag-ink-soft)]">{event.description}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-[var(--mag-ink-muted)]">
                        <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{event.location}</span>
                        <span className="inline-flex items-center gap-1"><Users className="h-3 w-3" />{count} attended</span>
                      </div>
                    </div>
                  </div>
                  {(event as any).createdById === session?.user?.id && (
                    <div className="mt-3 flex justify-center">
                      <Link to="/events/manage/$eventId" params={{ eventId: event.id }} className="inline-flex items-center gap-1 rounded-full border border-[var(--mag-line)] bg-[var(--mag-card)] px-4 py-2 text-xs font-medium text-[var(--mag-ink)] no-underline transition hover:bg-[var(--mag-surface)]">
                        Manage
                      </Link>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Bottom Create CTA */}
      <Link to="/events/create" className="mb-8 flex items-center justify-center gap-2 rounded-full bg-[var(--mag-ink)] py-3.5 text-sm font-medium text-[var(--mag-bg)] transition hover:opacity-80 no-underline">
        <Plus className="h-4 w-4" /> Create New Event
      </Link>

      {/* Enter event code modal */}
      {joinCodeModal?.open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 px-4 pb-6 sm:items-center sm:pb-0">
          <div className="w-full max-w-sm rounded-2xl bg-[var(--mag-card)] p-5 border border-[var(--mag-line)]">
            <h3 className="mb-1 text-base font-bold text-[var(--mag-ink)]">Join {joinCodeModal.eventName}</h3>
            <p className="mb-3 text-xs text-[var(--mag-ink-soft)]">Enter the event code to join.</p>
            <input
              type="text"
              value={enteredCode}
              onChange={(e) => { setJoinError(''); setJoinSuccess(''); setEnteredCode(e.target.value.toUpperCase()) }}
              placeholder="Enter code"
              maxLength={10}
              autoFocus
              disabled={!!joinSuccess}
              className="w-full rounded-2xl border border-[var(--mag-line)] bg-[var(--input-bg)] px-4 py-3 text-center text-sm font-mono tracking-widest uppercase text-[var(--mag-ink)] placeholder:font-sans placeholder:normal-case placeholder:tracking-normal focus:border-[var(--mag-ink)] focus:outline-none disabled:opacity-50"
            />
            {joinError && (
              <p className="mt-2 text-xs font-semibold text-[var(--mag-sale)]">{joinError}</p>
            )}
            {joinSuccess && (
              <div className="mt-2 rounded-xl border border-[var(--mag-line)] bg-[var(--mag-surface)] px-3 py-2 text-xs text-[var(--mag-ink-soft)]">
                {joinSuccess}
              </div>
            )}
            <div className="mt-4 flex gap-2">
              {joinSuccess ? (
                <button
                  onClick={() => { setJoinSuccess(''); setJoinCodeModal(null) }}
                  className="flex-1 rounded-full bg-[var(--mag-ink)] py-2.5 text-sm font-bold text-[var(--mag-bg)] transition hover:opacity-80"
                >
                  Got it
                </button>
              ) : (
                <>
                  <button
                    onClick={() => { setJoinError(''); setJoinSuccess(''); setJoinCodeModal(null) }}
                    className="flex-1 rounded-full border border-[var(--mag-line)] bg-[var(--mag-card)] py-2.5 text-sm font-medium text-[var(--mag-ink)] transition hover:bg-[var(--mag-surface)]"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      const code = enteredCode.trim()
                      if (!code) return
                      handleJoin(code)
                    }}
                    disabled={!enteredCode.trim()}
                    className="flex-1 rounded-full bg-[var(--mag-ink)] py-2.5 text-sm font-bold text-[var(--mag-bg)] transition hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Join
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Confirm leave + join modal */}
      {confirmModal?.open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 px-4 pb-6 sm:items-center sm:pb-0">
          <div className="w-full max-w-sm rounded-2xl bg-[var(--mag-card)] p-5 border border-[var(--mag-line)]">
            <h3 className="mb-1 text-base font-bold text-[var(--mag-ink)]">Leave current event?</h3>
            <p className="mb-3 text-xs text-[var(--mag-ink-soft)]">
              You are already checked into <strong className="text-[var(--mag-ink)]">{confirmModal.currentEventName}</strong>. You can only be in one event at a time.
            </p>
            <p className="mb-3 text-xs text-[var(--mag-ink-soft)]">
              Join <strong className="text-[var(--mag-ink)]">{confirmModal.eventName}</strong> anyway?
            </p>
            {joinError && (
              <p className="mb-3 text-xs font-semibold text-[var(--mag-sale)]">{joinError}</p>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => { setJoinError(''); setConfirmModal(null) }}
                className="flex-1 rounded-full border border-[var(--mag-line)] bg-[var(--mag-card)] py-2.5 text-sm font-medium text-[var(--mag-ink)] transition hover:bg-[var(--mag-surface)]"
              >
                Cancel
              </button>
              <button
                onClick={confirmJoin}
                className="flex-1 rounded-full bg-[var(--mag-ink)] py-2.5 text-sm font-bold text-[var(--mag-bg)] transition hover:opacity-80"
              >
                Switch Event
              </button>
            </div>
          </div>
        </div>
      )}

      </>)}
    </div>
  )
}
