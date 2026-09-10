import { createFileRoute, Link } from '@tanstack/react-router'
import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Skeleton } from '@heroui/react'
import { X, Heart, MapPin, Users, ArrowRight, Flag, MessageCircle, Briefcase, Zap, RotateCcw, Sparkles } from 'lucide-react'
import { getMyActiveEvent, reportUser } from '#/server/events'
import { recordSwipe, getSwipeDeck, rewindLastSwipe } from '#/server/swipes'
import { sendMessageRequest } from '#/server/requests'
import { getMyProfile } from '#/server/profiles'
import AvatarImage from '#/components/AvatarImage'
import { VerifiedBadge } from '#/components/VerifiedBadge'

export const Route = createFileRoute('/discover')({ component: DiscoverPage })

const REPORT_REASONS = [
  'Inappropriate behaviour',
  'Fake profile',
  'Harassment',
  'Spam or scam',
  'Other',
]

function formatNameWithGender(name: string | null, gender: string | null): string {
  const initial = gender === 'Male' ? 'M' : gender === 'Female' ? 'F' : ''
  return initial ? `${name || ''}, ${initial}` : (name || '')
}

const ONLINE_THRESHOLD_MS = 5 * 60 * 1000

function formatLastActive(dateLike: string | Date | null | undefined): { label: string; isOnline: boolean } | null {
  if (!dateLike) return null
  const date = new Date(dateLike)
  if (Number.isNaN(date.getTime())) return null
  const diffMs = Date.now() - date.getTime()
  if (diffMs < ONLINE_THRESHOLD_MS) return { label: 'Active now', isOnline: true }
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 60) return { label: `Active ${minutes}m ago`, isOnline: false }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { label: `Active ${hours}h ago`, isOnline: false }
  const days = Math.floor(hours / 24)
  if (days < 30) return { label: `Active ${days}d ago`, isOnline: false }
  return null
}

function DiscoverPage() {
  const queryClient = useQueryClient()
  const containerRef = useRef<HTMLDivElement>(null)
  const { data: activeEvent } = useQuery({ queryKey: ['active-event'], queryFn: () => getMyActiveEvent() })
  const { data: myProfile, isLoading: profileLoading } = useQuery({ queryKey: ['my-profile'], queryFn: () => getMyProfile() })

  // Global discovery is the default — event-scoped discovery only kicks in when
  // the user has explicitly opted into it (Settings > Discovery) and is checked
  // into an event.
  const isEventMode = myProfile?.discoveryMode === 'event' && !!activeEvent
  const effectiveEventId = isEventMode ? activeEvent!.id : undefined
  const isMystery = isEventMode && activeEvent?.mysteryMode === true
  const awaitingEventCheckIn = !profileLoading && myProfile?.discoveryMode === 'event' && !activeEvent

  const [selectedIntent, setSelectedIntent] = useState<'dating' | 'friends' | 'networking' | ''>('')

  // The deck is paged now — the server used to return every candidate in the
  // pool in one response.
  const {
    data: deckPages,
    isLoading: profilesLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['swipe-deck', effectiveEventId ?? 'global', selectedIntent],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getSwipeDeck({
        data: {
          eventId: effectiveEventId,
          intent: selectedIntent || undefined,
          offset: pageParam,
          limit: 30,
        },
      }),
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
    enabled: !profileLoading && !awaitingEventCheckIn,
  })

  const baseProfiles = useMemo(
    () => deckPages?.pages.flatMap((page) => page.items) ?? [],
    [deckPages],
  )

  const [currentIndex, setCurrentIndex] = useState(0)
  const [photoIndices, setPhotoIndices] = useState<Record<string, number>>({})
  const [swipedIds, setSwipedIds] = useState<Set<string>>(new Set())
  const [requestedIds, setRequestedIds] = useState<Set<string>>(new Set())
  const [requestPendingIds, setRequestPendingIds] = useState<Set<string>>(new Set())
  const [lastSwipe, setLastSwipe] = useState<{ userId: string; index: number } | null>(null)
  const [rewindError, setRewindError] = useState('')

  // Report modal state
  const [reportModalOpen, setReportModalOpen] = useState(false)
  const [reportReason, setReportReason] = useState('')
  const [reportCustom, setReportCustom] = useState('')
  const [reportSuccess, setReportSuccess] = useState('')

  const [swipeError, setSwipeError] = useState('')

  const swipeMutation = useMutation({
    mutationFn: recordSwipe,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['likes'] })
      queryClient.invalidateQueries({ queryKey: ['matches'] })
    },
    // The swipe was previously fire-and-forget: the card was marked swiped in
    // local state and the deck scrolled on, so a rate-limit rejection or a
    // dropped request silently lost the swipe. Roll the optimistic state back
    // and say so.
    onError: (error, vars) => {
      setSwipedIds((prev) => {
        const next = new Set(prev)
        next.delete(vars.data.swipedId)
        return next
      })
      setSwipeError((error as Error)?.message || 'Could not record that. Try again.')
      setTimeout(() => setSwipeError(''), 3000)
    },
  })

  const requestMutation = useMutation({
    mutationFn: sendMessageRequest,
    onSuccess: (_, vars) => {
      setRequestedIds((prev) => new Set(prev).add(vars.data.receiverId))
      queryClient.invalidateQueries({ queryKey: ['outgoing-requests'] })
    },
    onSettled: (_, __, vars) => {
      setRequestPendingIds((prev) => {
        const next = new Set(prev)
        next.delete(vars.data.receiverId)
        return next
      })
    },
  })

  const rewindMutation = useMutation({
    mutationFn: (vars: { userId: string; index: number }) =>
      rewindLastSwipe({ data: { eventId: effectiveEventId, swipedId: vars.userId } }),
    onSuccess: (result, vars) => {
      if (!result.success) {
        setRewindError(result.message || 'Unable to rewind')
        setTimeout(() => setRewindError(''), 2000)
        return
      }
      setSwipedIds((prev) => {
        const next = new Set(prev)
        next.delete(vars.userId)
        return next
      })
      setLastSwipe(null)
      setCurrentIndex(vars.index)
      const container = containerRef.current
      const target = container?.children[vars.index] as HTMLElement | undefined
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    },
  })

  const reportMutation = useMutation({
    mutationFn: reportUser,
    onSuccess: (res) => {
      if (res.success) {
        setReportSuccess('Report submitted. The organizer has been notified.')
        setTimeout(() => {
          setReportModalOpen(false)
          setReportSuccess('')
          setReportReason('')
          setReportCustom('')
        }, 1500)
      } else {
        setReportSuccess(res.message || 'Unable to submit report.')
      }
    },
  })

  const handleAction = useCallback((direction: 'like' | 'pass') => {
    const profile = baseProfiles[currentIndex]
    if (!profile) return
    if (swipedIds.has(profile.userId)) return

    setSwipedIds((prev) => new Set(prev).add(profile.userId))
    setLastSwipe({ userId: profile.userId, index: currentIndex })
    swipeMutation.mutate({ data: { eventId: effectiveEventId, swipedId: profile.userId, direction } })

    const container = containerRef.current
    if (!container) return
    const next = currentIndex + 1
    if (next < container.children.length) {
      ;(container.children[next] as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [currentIndex, effectiveEventId, baseProfiles, swipeMutation, swipedIds])

  const handleRewind = useCallback(() => {
    if (!lastSwipe || rewindMutation.isPending) return
    rewindMutation.mutate(lastSwipe)
  }, [lastSwipe, rewindMutation])

  const handleRequest = useCallback(() => {
    const profile = baseProfiles[currentIndex]
    if (!profile) return
    if (requestedIds.has(profile.userId) || requestPendingIds.has(profile.userId)) return

    setRequestPendingIds((prev) => new Set(prev).add(profile.userId))
    requestMutation.mutate({ data: { eventId: effectiveEventId, receiverId: profile.userId } })
  }, [currentIndex, effectiveEventId, baseProfiles, requestMutation, requestedIds, requestPendingIds])

  const handleReport = () => {
    const profile = baseProfiles[currentIndex]
    if (!profile) return
    const reason = reportReason === 'Other' ? reportCustom.trim() : reportReason
    if (!reason) return
    reportMutation.mutate({ data: { eventId: effectiveEventId, reportedId: profile.userId, reason } })
  }

  const nextPhoto = (profileId: string, max: number) => {
    setPhotoIndices((prev) => ({ ...prev, [profileId]: Math.min((prev[profileId] ?? 0) + 1, max - 1) }))
  }
  const prevPhoto = (profileId: string) => {
    setPhotoIndices((prev) => ({ ...prev, [profileId]: Math.max((prev[profileId] ?? 0) - 1, 0) }))
  }

  // The scroll handler ran setCurrentIndex on every scroll event, re-rendering
  // every mounted card each frame. Coalesce to one update per animation frame,
  // and skip the state write entirely when the index hasn't changed.
  const scrollFrameRef = useRef<number | null>(null)

  const onScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) return
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null
      const container = containerRef.current
      if (!container || container.clientHeight === 0) return
      const idx = Math.round(container.scrollTop / container.clientHeight)
      const clamped = Math.min(Math.max(idx, 0), Math.max(baseProfiles.length - 1, 0))
      setCurrentIndex((prev) => (prev === clamped ? prev : clamped))
    })
  }, [baseProfiles.length])

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current)
    }
  }, [])

  // Pull the next page as the user approaches the end of the loaded deck.
  useEffect(() => {
    if (!hasNextPage || isFetchingNextPage) return
    if (baseProfiles.length - currentIndex > 8) return
    void fetchNextPage()
  }, [currentIndex, baseProfiles.length, hasNextPage, isFetchingNextPage, fetchNextPage])

  // Only mount cards near the viewport. Rendering the whole deck meant N
  // full-screen sections, each with its own image, live at once.
  const WINDOW_BEHIND = 1
  const WINDOW_AHEAD = 3
  const windowStart = Math.max(0, currentIndex - WINDOW_BEHIND)
  const windowEnd = Math.min(baseProfiles.length, currentIndex + WINDOW_AHEAD + 1)

  if (awaitingEventCheckIn) {
    return (
      <div className="page-wrap flex min-h-[90vh] flex-col items-center justify-center px-4 py-16 text-center">
        <Users className="mb-4 h-16 w-16 text-[var(--mag-ink-muted)]" />
        <h2 className="text-xl font-bold text-[var(--mag-ink)]">Join an Event First</h2>
        <p className="mt-2 max-w-xs text-sm text-[var(--mag-ink-soft)]">
          Your discovery is set to event-only in Settings. Check into an event to start swiping, or switch back to the global pool.
        </p>
        <Link to="/events" className="mt-6 inline-flex items-center gap-2 rounded-full bg-[var(--mag-ink)] px-6 py-3 text-sm font-bold !text-[var(--mag-bg)] no-underline transition hover:opacity-80 active:scale-95">
          Browse Events <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    )
  }

  if (profileLoading || profilesLoading) {
    return (
      <div className="flex h-[calc(100dvh-112px)] flex-col bg-[var(--mag-bg)]">
        <div className="shrink-0 px-4 py-2">
          <div className="flex gap-2 overflow-x-auto hide-scrollbar">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-7 w-24 shrink-0 rounded-full" />
            ))}
          </div>
        </div>
        <div className="flex-1 px-4 py-4">
          <Skeleton className="h-full w-full rounded-2xl" />
        </div>
      </div>
    )
  }

  if (baseProfiles.length === 0) {
    return (
      <div className="page-wrap flex min-h-[90vh] flex-col items-center justify-center px-4 py-16 text-center">
        <Users className="mb-4 h-16 w-16 text-[var(--mag-ink-muted)]" />
        <h2 className="text-xl font-bold text-[var(--mag-ink)]">Nobody Here Yet</h2>
        <p className="mt-2 max-w-xs text-sm text-[var(--mag-ink-soft)]">
          {isEventMode
            ? "Other attendees haven't joined, or you've already swiped through everyone in this event."
            : "Nobody new to show right now, or you've already swiped through everyone."}
        </p>
        <Link to="/events" className="mt-6 inline-flex items-center gap-2 rounded-full bg-[var(--mag-ink)] px-6 py-3 text-sm font-bold !text-[var(--mag-bg)] no-underline transition hover:opacity-80 active:scale-95">
          Browse Events <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    )
  }

  return (
    <div className="flex h-[calc(100dvh-112px)] flex-col bg-[var(--mag-bg)]">
      <div className="shrink-0 px-4 py-2">
        <div className="flex gap-2 overflow-x-auto hide-scrollbar">
          {[
            { value: 'dating' as const, label: 'Dating', icon: Heart },
            { value: 'friends' as const, label: 'Friends', icon: Users },
            { value: 'networking' as const, label: 'Networking', icon: Briefcase },
          ].map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              onClick={() => setSelectedIntent((prev) => (prev === value ? '' : value))}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition ${
                selectedIntent === value
                  ? 'bg-[var(--mag-ink)] text-[var(--mag-bg)]'
                  : 'border border-[var(--mag-line)] bg-[var(--mag-card)] text-[var(--mag-ink-soft)]'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>
      {(rewindError || swipeError) && (
        <div className="shrink-0 px-4 pb-2">
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-center">
            <p className="text-xs font-medium text-amber-800">{rewindError || swipeError}</p>
          </div>
        </div>
      )}
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="hide-scrollbar flex-1 w-full snap-y snap-mandatory overflow-y-auto"
        style={{ scrollBehavior: 'smooth' }}
      >
        {baseProfiles.map((profile, index) => {
          // Cards outside the window keep their slot (so scroll position and
          // snap points stay correct) but render nothing.
          if (index < windowStart || index >= windowEnd) {
            return (
              <section
                key={profile.userId}
                data-index={index}
                aria-hidden="true"
                className="relative h-full w-full shrink-0 snap-start snap-stop overflow-hidden bg-[var(--mag-surface)]"
              />
            )
          }

          const photoIdx = photoIndices[profile.userId] ?? 0
          const pic = profile.photos[photoIdx] ?? ''
          const hasPhotos = profile.photos.length > 0
          const lastActive = formatLastActive(profile.lastActiveDate)
          const sharedInterests: string[] = profile.sharedInterests ?? []
          return (
            <section
              key={profile.userId}
              data-index={index}
              className="relative h-full w-full shrink-0 snap-start snap-stop overflow-hidden"
            >
              <div className="h-full w-full">
                <AvatarImage
                  src={pic}
                  alt={profile.name ?? ''}
                  priority={index === currentIndex}
                  imgClassName={isMystery ? 'blur-[20px] grayscale-[0.5] transition-all duration-1000' : ''}
                />
              </div>
              <div className="gradient-overlay absolute inset-0" />
              {isMystery && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="rounded-lg bg-black/50 px-3 py-1.5 text-xs font-bold text-white backdrop-blur-sm">
                    Locked - Reveal after 10 messages
                  </span>
                </div>
              )}
              {isMystery && (
                <div className="absolute top-4 right-4 z-10">
                  <span className="rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-bold text-white backdrop-blur-sm">
                    MYSTERY
                  </span>
                </div>
              )}
              {profile.isBoosted && (
                <div className="absolute top-4 left-4 z-10">
                  <span className="inline-flex items-center gap-1 rounded-full bg-[var(--mag-ink)]/90 px-2 py-0.5 text-[10px] font-bold text-white backdrop-blur-sm">
                    <Zap className="h-3 w-3" /> BOOSTED
                  </span>
                </div>
              )}
              {hasPhotos && (
                <>
                  <div className="absolute top-4 left-4 right-4 flex gap-1.5">
                    {profile.photos.map((_, i) => (
                      <div
                        key={i}
                        className={`h-1 flex-1 rounded-full transition ${i === photoIdx ? 'bg-white' : 'bg-white/40'}`}
                      />
                    ))}
                  </div>
                  <button
                    onClick={() => prevPhoto(profile.userId)}
                    className="absolute left-0 top-0 h-[40%] w-1/4"
                    aria-label="Previous photo"
                  />
                  <button
                    onClick={() => nextPhoto(profile.userId, profile.photos.length)}
                    className="absolute right-0 top-0 h-[40%] w-1/4"
                    aria-label="Next photo"
                  />
                </>
              )}
              <div className="absolute bottom-0 left-0 right-0 p-5 pb-28">
                <h2 className="text-3xl font-bold text-white flex items-center gap-2">
                  {formatNameWithGender(profile.name, profile.gender)}
                  {profile.verifiedAt && <VerifiedBadge />}
                </h2>
                {lastActive && (
                  <div className="mt-1 flex items-center gap-1.5 text-xs font-medium text-white/80">
                    {lastActive.isOnline && (
                      <span className="h-2 w-2 rounded-full bg-emerald-400" />
                    )}
                    <span>{lastActive.label}</span>
                  </div>
                )}
                {profile.lookingFor && profile.lookingFor.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {profile.lookingFor.map((intent) => (
                      <span
                        key={intent}
                        className="rounded-full bg-white/20 px-2.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur-sm"
                      >
                        {intent.charAt(0).toUpperCase() + intent.slice(1)}
                      </span>
                    ))}
                  </div>
                )}
                <div className="mt-1 flex items-center gap-1.5 text-sm text-white/80">
                  <MapPin className="h-4 w-4" />
                  <span>{profile.location}</span>
                </div>
                {sharedInterests.length > 0 && (
                  <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-[var(--mag-ink)]/80 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur-sm">
                    <Sparkles className="h-3 w-3" />
                    <span>
                      {sharedInterests.length} thing{sharedInterests.length === 1 ? '' : 's'} in common:{' '}
                      {sharedInterests.slice(0, 3).join(', ')}
                    </span>
                  </div>
                )}
                <p className="mt-2 max-w-md text-sm leading-relaxed text-white/80">{profile.bio}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {profile.interests.slice(0, 5).map((interest) => (
                    <span
                      key={interest}
                      className="rounded-full bg-white/20 px-3 py-1 text-xs font-medium text-white backdrop-blur-sm"
                    >
                      {interest}
                    </span>
                  ))}
                </div>
              </div>
              <div className="absolute right-3 bottom-28 flex flex-col items-center gap-3">
                {lastSwipe && (
                  <button
                    onClick={handleRewind}
                    disabled={rewindMutation.isPending}
                    className="flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-black/30 backdrop-blur-sm transition hover:scale-110 disabled:opacity-40"
                    title="Rewind last swipe"
                  >
                    <RotateCcw className="h-4 w-4 text-amber-300" />
                  </button>
                )}
                <button
                  onClick={() => handleAction('like')}
                  disabled={swipedIds.has(profile.userId)}
                  className={`flex h-12 w-12 items-center justify-center rounded-full border border-white/20 backdrop-blur-sm transition hover:scale-110 disabled:opacity-40 disabled:hover:scale-100 ${
                    swipedIds.has(profile.userId) ? 'bg-[var(--mag-ink)]' : 'bg-black/30'
                  }`}
                >
                  <Heart
                    className={`h-6 w-6 ${
                      swipedIds.has(profile.userId)
                        ? 'fill-white text-white'
                        : 'fill-transparent text-white'
                    }`}
                  />
                </button>
                <button
                  onClick={handleRequest}
                  disabled={requestedIds.has(profile.userId) || requestPendingIds.has(profile.userId)}
                  className={`flex h-12 w-12 items-center justify-center rounded-full border border-white/20 backdrop-blur-sm transition hover:scale-110 disabled:opacity-40 disabled:hover:scale-100 ${
                    requestedIds.has(profile.userId) ? 'bg-[var(--mag-ink)]' : 'bg-black/30'
                  }`}
                  title={requestedIds.has(profile.userId) ? 'Request sent' : 'Send message request'}
                >
                  {requestPendingIds.has(profile.userId) ? (
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  ) : (
                    <MessageCircle
                      className={`h-6 w-6 ${
                        requestedIds.has(profile.userId)
                          ? 'fill-white text-white'
                          : 'fill-transparent text-white'
                      }`}
                    />
                  )}
                </button>
                <button
                  onClick={() => handleAction('pass')}
                  disabled={swipedIds.has(profile.userId)}
                  className={`flex h-12 w-12 items-center justify-center rounded-full border border-white/20 backdrop-blur-sm transition hover:scale-110 disabled:opacity-40 disabled:hover:scale-100 ${
                    swipedIds.has(profile.userId) ? 'bg-[var(--mag-ink)]' : 'bg-black/30'
                  }`}
                >
                  <X
                    className="h-6 w-6 text-white"
                    strokeWidth={2.5}
                  />
                </button>
                <button
                  onClick={() => {
                    setReportModalOpen(true)
                    setReportReason('')
                    setReportCustom('')
                    setReportSuccess('')
                  }}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-black/30 backdrop-blur-sm transition hover:scale-110"
                  title="Report user"
                >
                  <Flag className="h-4 w-4 text-white" />
                </button>
              </div>
            </section>
          )
        })}
      </div>

      {/* Report Modal */}
      {reportModalOpen && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 px-4 pb-20 sm:items-center sm:pb-0">
          <div className="w-full max-w-sm rounded-2xl bg-[var(--mag-card)] border border-[var(--mag-line)] p-5">
            <h3 className="mb-1 text-base font-bold text-[var(--mag-ink)]">Report user</h3>
            <p className="mb-4 text-xs text-[var(--mag-ink-soft)]">
              This will be sent to the event organizer. Be honest — false reports may result in action against you.
            </p>

            {reportSuccess ? (
              <div className="rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-surface)] px-4 py-3 text-xs text-[var(--mag-success)]">
                {reportSuccess}
              </div>
            ) : (
              <>
                <div className="mb-3 space-y-2">
                  {REPORT_REASONS.map((r) => (
                    <label
                      key={r}
                      className="flex cursor-pointer items-center gap-2 rounded-xl border border-[var(--mag-line)] bg-[var(--mag-surface)] px-3 py-2 transition hover:border-[var(--mag-line)]"
                    >
                      <input
                        type="radio"
                        name="reportReason"
                        value={r}
                        checked={reportReason === r}
                        onChange={() => setReportReason(r)}
                        className="h-4 w-4 accent-[#111111]"
                      />
                      <span className="text-sm text-[var(--mag-ink)]">{r}</span>
                    </label>
                  ))}
                </div>

                {reportReason === 'Other' && (
                  <textarea
                    value={reportCustom}
                    onChange={(e) => setReportCustom(e.target.value)}
                    placeholder="Describe the issue..."
                    rows={3}
                    className="mb-3 w-full resize-none rounded-xl border border-[var(--mag-line)] bg-[var(--input-bg)] px-3 py-2 text-sm text-[var(--mag-ink)] focus:border-[var(--mag-ink)] focus:outline-none"
                  />
                )}

                <div className="flex gap-2">
                  <button
                    onClick={() => setReportModalOpen(false)}
                    className="flex-1 rounded-full border border-[var(--mag-line)] bg-[var(--mag-card)] py-2.5 text-sm font-medium text-[var(--mag-ink)] transition hover:bg-[var(--mag-surface)]"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleReport}
                    disabled={
                      !reportReason || (reportReason === 'Other' && !reportCustom.trim()) || reportMutation.isPending
                    }
                    className="flex-1 rounded-full bg-[var(--mag-ink)] py-2.5 text-sm font-bold text-[var(--mag-bg)] transition hover:opacity-80 disabled:opacity-50 active:scale-95"
                  >
                    {reportMutation.isPending ? 'Submitting…' : 'Submit Report'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
