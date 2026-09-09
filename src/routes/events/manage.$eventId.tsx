import { createFileRoute, useNavigate, useParams } from '@tanstack/react-router'
import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Skeleton } from '@heroui/react'
import {
  ArrowLeft,
  Save,
  Play,
  Square,
  Trash2,
  Users,
  MapPin,
  Calendar,
  CheckCircle2,
  Link2,
  MessageCircle,
  Ban,
  UserX,
  Flag,
  ShieldAlert,
  X,
  ImageIcon,
  Eye,
  Lock,
  ListOrdered,
  Sparkles,
} from 'lucide-react'
import {
  getEventById,
  updateEvent,
  deleteEvent,
  getEventAttendees,
  removeEventAttendee,
  blockEventAttendee,
  unblockEventAttendee,
  getEventBlockedUsers,
  getEventReports,
  getEventWaitlist,
  removeFromWaitlist,
  getEventPosts,
  createEventPost,
} from '#/server/events'
import { updateEventSponsor, removeEventSponsor } from '#/server/sponsors'
import { getSession } from '#/server/auth'
import AvatarImage from '#/components/AvatarImage'
import { VerifiedBadge } from '#/components/VerifiedBadge'
import { uploadImageToR2, maybeDeleteR2Image } from '#/lib/upload'
import { localDatetimeToUTCISO, toDatetimeLocalValue } from '#/lib/datetime'

export const Route = createFileRoute('/events/manage/$eventId')({ component: ManageEventPage })

function ManageEventPage() {
  const { eventId } = useParams({ from: '/events/manage/$eventId' })
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: session } = useQuery({
    queryKey: ['session'],
    queryFn: () => getSession(),
  })

  const {
    data: event,
    isLoading: eventLoading,
    isError: eventError,
  } = useQuery({
    queryKey: ['event', eventId],
    queryFn: () => getEventById({ data: eventId }),
  })

  const { data: attendeeProfiles = [], isLoading: profilesLoading } = useQuery({
    queryKey: ['event-attendees', eventId],
    queryFn: () => getEventAttendees({ data: eventId }),
    enabled: !!eventId,
  })

  const { data: reports = [] } = useQuery({
    queryKey: ['event-reports', eventId],
    queryFn: () => getEventReports({ data: eventId }),
    enabled: !!eventId,
  })

  const { data: blockedUsers = [] } = useQuery({
    queryKey: ['event-blocked', eventId],
    queryFn: () => getEventBlockedUsers({ data: eventId }),
    enabled: !!eventId,
  })

  const { data: waitlist = [], isLoading: waitlistLoading } = useQuery({
    queryKey: ['event-waitlist', eventId],
    queryFn: () => getEventWaitlist({ data: eventId }),
    enabled: !!eventId,
  })

  const attendeeCount = (event as any)?._count?.attendees ?? 0

  const { data: postsData, isLoading: postsLoading } = useQuery({
    queryKey: ['event-posts', eventId],
    queryFn: () => getEventPosts({ data: { eventId, limit: 20 } }),
    enabled: !!eventId,
  })
  const eventPosts = postsData?.items ?? []

  const [postContent, setPostContent] = useState('')

  const loadMorePosts = async () => {
    if (!postsData?.nextCursor) return
    const more = await getEventPosts({ data: { eventId, cursor: postsData.nextCursor, limit: 20 } })
    queryClient.setQueryData(['event-posts', eventId], {
      items: [...eventPosts, ...more.items],
      nextCursor: more.nextCursor,
    })
  }

  const createPostMutation = useMutation({
    mutationFn: createEventPost,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['event-posts', eventId] })
      setPostContent('')
    },
  })

  // Editable form state
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [location, setLocation] = useState('')
  const [maxAttendees, setMaxAttendees] = useState<string>('')
  const [startsAt, setStartsAt] = useState<string>('')
  const [savedMsg, setSavedMsg] = useState(false)
  const [copied, setCopied] = useState(false)
  const [activeTab, setActiveTab] = useState<'attendees' | 'waitlist' | 'reports' | 'blocked' | 'activity'>('attendees')

  const [eventPhoto, setEventPhoto] = useState<string | null>(null)
  const [eventIsPublic, setEventIsPublic] = useState(true)
  const [eventMysteryMode, setEventMysteryMode] = useState(false)
  const [photoError, setPhotoError] = useState('')
  const [saveError, setSaveError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  // Sponsor branding state
  const [sponsorName, setSponsorName] = useState('')
  const [sponsorLogo, setSponsorLogo] = useState('')
  const [sponsorFrameUrl, setSponsorFrameUrl] = useState('')
  const [sponsorSaved, setSponsorSaved] = useState(false)
  const [sponsorError, setSponsorError] = useState('')

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setPhotoError('')
    try {
      const key = `events/${eventId}/photo-${crypto.randomUUID()}.jpg`
      const url = await uploadImageToR2(file, key)

      if (eventPhoto?.startsWith('http')) {
        await maybeDeleteR2Image(eventPhoto).catch(() => {})
      }

      setEventPhoto(url)
    } catch {
      setPhotoError('Failed to process image.')
    }
    e.target.value = ''
  }

  useEffect(() => {
    if (event) {
      setName(event.name ?? '')
      setDescription(event.description ?? '')
      setLocation(event.location ?? '')
      setMaxAttendees(event.maxAttendees != null ? String(event.maxAttendees) : '')
      setStartsAt(event.startsAt ? toDatetimeLocalValue(event.startsAt) : '')
      setEventPhoto(event.photo ?? null)
      setEventIsPublic((event as any).isPublic ?? true)
      setEventMysteryMode((event as any).mysteryMode ?? false)
      setSponsorName((event as any).sponsorName ?? '')
      setSponsorLogo((event as any).sponsorLogo ?? '')
      setSponsorFrameUrl((event as any).sponsorFrameUrl ?? '')
    }
  }, [event])

  const isCreator = !!session?.user?.id && (event as any)?.createdById === session.user.id

  const updateMutation = useMutation({
    mutationFn: updateEvent,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['event', eventId] })
      queryClient.invalidateQueries({ queryKey: ['events'] })
      setSaveError('')
      setSavedMsg(true)
      setTimeout(() => setSavedMsg(false), 2000)
    },
    onError: (err: any) => {
      const message = err?.message || err?.error?.message || 'Failed to save changes.'
      setSaveError(message)
    },
  })

  const toggleActiveMutation = useMutation({
    mutationFn: updateEvent,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['event', eventId] })
      queryClient.invalidateQueries({ queryKey: ['events'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: deleteEvent,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['events'] })
      navigate({ to: '/events' })
    },
  })

  const removeMutation = useMutation({
    mutationFn: removeEventAttendee,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['event-attendees', eventId] })
      queryClient.invalidateQueries({ queryKey: ['event', eventId] })
    },
  })

  const blockMutation = useMutation({
    mutationFn: blockEventAttendee,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['event-attendees', eventId] })
      queryClient.invalidateQueries({ queryKey: ['event-blocked', eventId] })
      queryClient.invalidateQueries({ queryKey: ['event', eventId] })
    },
  })

  const unblockMutation = useMutation({
    mutationFn: unblockEventAttendee,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['event-blocked', eventId] })
    },
  })

  const removeWaitlistMutation = useMutation({
    mutationFn: removeFromWaitlist,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['event-waitlist', eventId] })
      queryClient.invalidateQueries({ queryKey: ['event', eventId] })
    },
  })

  const updateSponsorMutation = useMutation({
    mutationFn: updateEventSponsor,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['event', eventId] })
      queryClient.invalidateQueries({ queryKey: ['events'] })
      setSponsorError('')
      setSponsorSaved(true)
      setTimeout(() => setSponsorSaved(false), 2000)
    },
    onError: (err: any) => {
      const message = err?.message || err?.error?.message || 'Failed to update sponsor.'
      setSponsorError(message)
    },
  })

  const removeSponsorMutation = useMutation({
    mutationFn: removeEventSponsor,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['event', eventId] })
      queryClient.invalidateQueries({ queryKey: ['events'] })
      setSponsorName('')
      setSponsorLogo('')
      setSponsorFrameUrl('')
      setSponsorError('')
    },
    onError: (err: any) => {
      const message = err?.message || err?.error?.message || 'Failed to remove sponsor.'
      setSponsorError(message)
    },
  })

  const handleSave = () => {
    const startsAtIso = startsAt ? localDatetimeToUTCISO(startsAt) : undefined
    updateMutation.mutate({
      data: {
        eventId,
        data: {
          name: name.trim() || undefined,
          description: description.trim() || undefined,
          location: location.trim() || undefined,
          maxAttendees: maxAttendees ? Number(maxAttendees) : undefined,
          startsAt: startsAtIso,
          photo: eventPhoto,
          isPublic: eventIsPublic,
          mysteryMode: eventMysteryMode,
        },
      },
    })
  }

  const handleToggleActive = () => {
    const nextActive = !event?.isActive
    toggleActiveMutation.mutate({
      data: {
        eventId,
        data: {
          isActive: nextActive,
          endedAt: !nextActive ? new Date().toISOString() : undefined,
        },
      },
    })
  }

  const handleDelete = () => {
    if (!confirm('Are you sure you want to delete this event? This cannot be undone.')) return
    deleteMutation.mutate({ data: eventId })
  }

  const handleCopyLink = () => {
    const link = `${window.location.origin}/events/join/${(event as any).code}`
    navigator.clipboard.writeText(link).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const handleRemove = (userId: string, name: string) => {
    if (!confirm(`Remove ${name || 'this user'} from the event?`)) return
    removeMutation.mutate({ data: { eventId, userId } })
  }

  const handleBlock = (userId: string, name: string) => {
    const reason = prompt(`Why do you want to block ${name || 'this user'}? (optional)`)
    if (reason === null) return // cancelled
    blockMutation.mutate({ data: { eventId, userId, reason: reason || undefined } })
  }

  const handleUnblock = (userId: string) => {
    if (!confirm('Unblock this user? They will be able to join again.')) return
    unblockMutation.mutate({ data: { eventId, userId } })
  }

  const handleRemoveWaitlist = (userId: string, name: string) => {
    if (!confirm(`Remove ${name || 'this user'} from the waitlist?`)) return
    removeWaitlistMutation.mutate({ data: { eventId, userId } })
  }

  if (eventLoading) {
    return (
      <main className="page-wrap px-4 py-4">
        <div className="mb-5 flex items-center gap-2">
          <button
            onClick={() => navigate({ to: '/events' })}
            className="rounded-full p-2 text-[var(--mag-ink-soft)] transition hover:bg-[var(--mag-surface)]"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <h1 className="text-lg font-bold text-[var(--mag-ink)]">Manage Event</h1>
        </div>
        <div className="space-y-4">
          <div className="rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-4 text-center space-y-2">
            <Skeleton className="mx-auto h-3 w-24 rounded-lg" />
            <Skeleton className="mx-auto h-10 w-40 rounded-lg" />
            <Skeleton className="mx-auto h-8 w-28 rounded-full" />
          </div>
          <div className="rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-3 space-y-3">
            <Skeleton className="mx-auto h-5 w-28 rounded-lg" />
            <Skeleton className="h-32 w-32 mx-auto rounded-2xl" />
            <Skeleton className="h-10 w-full rounded-2xl" />
            <Skeleton className="h-20 w-full rounded-2xl" />
            <Skeleton className="h-10 w-full rounded-2xl" />
            <div className="flex gap-2">
              <Skeleton className="h-10 flex-1 rounded-full" />
              <Skeleton className="h-10 flex-1 rounded-full" />
            </div>
          </div>
          <div className="rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-1 flex gap-1">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-9 flex-1 rounded-lg" />
            ))}
          </div>
          <div className="rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-3 space-y-3">
            <div className="flex items-center justify-between">
              <Skeleton className="h-4 w-20 rounded-lg" />
              <Skeleton className="h-4 w-16 rounded-full" />
            </div>
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3 rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-surface)] p-3">
                <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-24 rounded-lg" />
                  <Skeleton className="h-2.5 w-32 rounded-lg" />
                </div>
                <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
              </div>
            ))}
          </div>
        </div>
      </main>
    )
  }

  if (!event) {
    return (
      <main className="page-wrap px-4 py-4">
        <div className="mb-5 flex items-center gap-2">
          <button
            onClick={() => navigate({ to: '/events' })}
            className="rounded-full p-2 text-[var(--mag-ink-soft)] transition hover:bg-[var(--mag-surface)]"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <h1 className="text-lg font-bold text-[var(--mag-ink)]">Manage Event</h1>
        </div>
        <div className="rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-5 text-center">
          <p className="text-sm font-semibold text-[var(--mag-ink)]">You don't have permission to manage this event.</p>
          <button
            onClick={() => navigate({ to: '/events' })}
            className="mt-4 inline-flex items-center justify-center rounded-full bg-[var(--mag-ink)] px-6 py-2.5 text-xs font-bold text-[var(--mag-bg)] transition hover:opacity-80"
          >
            Go Back
          </button>
        </div>
      </main>
    )
  }

  if (eventError || !isCreator) {
    return (
      <main className="page-wrap px-4 py-4">
        <div className="mb-5 flex items-center gap-2">
          <button
            onClick={() => navigate({ to: '/events' })}
            className="rounded-full p-2 text-[var(--mag-ink-soft)] transition hover:bg-[var(--mag-surface)]"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <h1 className="text-lg font-bold text-[var(--mag-ink)]">Manage Event</h1>
        </div>
        <div className="rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-5 text-center">
          <p className="text-sm font-semibold text-[var(--mag-ink)]">You don't have permission to manage this event.</p>
          <button
            onClick={() => navigate({ to: '/events' })}
            className="mt-4 inline-flex items-center justify-center rounded-full bg-[var(--mag-ink)] px-6 py-2.5 text-xs font-bold text-[var(--mag-bg)] transition hover:opacity-80"
          >
            Go Back
          </button>
        </div>
      </main>
    )
  }

  return (
    <main className="page-wrap px-4 py-4">
      {/* Header */}
      <div className="mb-5 flex items-center gap-2">
        <button
          onClick={() => navigate({ to: '/events' })}
          className="rounded-full p-2 text-[var(--mag-ink-soft)] transition hover:bg-[var(--mag-surface)]"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-lg font-bold text-[var(--mag-ink)]">Manage Event</h1>
      </div>

      {/* Event Code */}
      <div className="mb-6 rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-4 text-center">
        <p className="text-xs font-medium text-[var(--mag-ink-soft)] uppercase tracking-wide">Event Code</p>
        <p className="mt-2 text-4xl font-mono font-bold tracking-widest text-[var(--mag-ink)]">{(event as any).code}</p>
        <p className="mt-1 text-[10px] text-[var(--mag-ink-muted)]">Share this code so others can join</p>
        <button
          onClick={handleCopyLink}
          className="mt-3 inline-flex items-center justify-center gap-1.5 rounded-full border border-[var(--mag-line)] bg-[var(--mag-surface)] px-4 py-2 text-xs font-medium text-[var(--mag-ink)] transition hover:border-[var(--mag-ink)] hover:text-[var(--mag-ink)]"
        >
          <Link2 className="h-3.5 w-3.5" />
          {copied ? 'Copied!' : 'Copy Share Link'}
        </button>
      </div>

      {/* Event Details */}
      <section className="mb-6 rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-3">
        <h2 className="mb-3 text-center text-sm font-bold text-[var(--mag-ink)]">Event Details</h2>
        <div className="mx-auto max-w-md space-y-4">
          <div>
            <label className="mb-1.5 block text-center text-xs font-medium text-[var(--mag-ink)]">Event Photo</label>
            <div className="flex justify-center">
              {eventPhoto ? (
                <div className="relative inline-block">
                <img src={eventPhoto} alt="Event" className="h-32 w-32 rounded-2xl object-cover" />
                <button
                  type="button"
                  onClick={() => {
                    if (eventPhoto?.startsWith('http')) {
                      maybeDeleteR2Image(eventPhoto).catch(() => {})
                    }
                    setEventPhoto(null)
                  }}
                  className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-[var(--mag-sale)] text-[var(--mag-bg)]"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex h-32 w-32 items-center justify-center rounded-2xl border border-dashed border-[var(--mag-line)] bg-[var(--mag-surface)] text-[var(--mag-ink-muted)] transition hover:border-[var(--mag-ink)] hover:text-[var(--mag-ink)]"
              >
                <ImageIcon className="h-6 w-6" />
              </button>
            )}
              <input type="file" accept="image/*" ref={fileRef} onChange={handleFile} className="hidden" />
            </div>
            {photoError && (
              <p className="mt-2 text-center text-xs font-semibold text-[var(--mag-sale)]">{photoError}</p>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-[var(--mag-ink)]">Event Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-2xl border border-[var(--mag-line)] bg-[var(--input-bg)] px-4 py-3 text-sm text-[var(--mag-ink)] focus:border-[var(--mag-ink)] focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-[var(--mag-ink)]">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full resize-none rounded-2xl border border-[var(--mag-line)] bg-[var(--input-bg)] px-4 py-3 text-sm text-[var(--mag-ink)] focus:border-[var(--mag-ink)] focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-[var(--mag-ink)]">Location</label>
            <div className="relative">
              <MapPin className="absolute left-3 top-3 h-4 w-4 text-[var(--mag-ink-muted)]" />
              <input
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                className="w-full rounded-2xl border border-[var(--mag-line)] bg-[var(--input-bg)] py-3 pl-10 pr-4 text-sm text-[var(--mag-ink)] focus:border-[var(--mag-ink)] focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-[var(--mag-ink)]">Max Attendees</label>
            <input
              type="number"
              min={1}
              value={maxAttendees}
              onChange={(e) => setMaxAttendees(e.target.value)}
              placeholder="Optional"
              className="w-full rounded-2xl border border-[var(--mag-line)] bg-[var(--input-bg)] px-4 py-3 text-sm text-[var(--mag-ink)] focus:border-[var(--mag-ink)] focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-center text-xs font-medium text-[var(--mag-ink)]">Visibility</label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setEventIsPublic(true)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-xs font-semibold transition ${
                  eventIsPublic
                    ? 'bg-[var(--mag-ink)] text-[var(--mag-bg)]'
                    : 'border border-[var(--mag-line)] bg-[var(--mag-card)] text-[var(--mag-ink-soft)] hover:bg-[var(--mag-surface)]'
                }`}
              >
                <Eye className="h-3.5 w-3.5" /> Public
              </button>
              <button
                type="button"
                onClick={() => setEventIsPublic(false)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-xs font-semibold transition ${
                  !eventIsPublic
                    ? 'bg-[var(--mag-ink)] text-[var(--mag-bg)]'
                    : 'border border-[var(--mag-line)] bg-[var(--mag-card)] text-[var(--mag-ink-soft)] hover:bg-[var(--mag-surface)]'
                }`}
              >
                <Lock className="h-3.5 w-3.5" /> Private
              </button>
            </div>
            <p className="mt-1 text-center text-[10px] text-[var(--mag-ink-muted)]">
              {eventIsPublic
                ? 'Anyone can find this event on the browse page.'
                : 'Only people with the code or link can join.'}
            </p>
          </div>

          <div>
            <label className="mb-1.5 block text-center text-xs font-medium text-[var(--mag-ink)]">Mystery Mode</label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setEventMysteryMode(true)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-xs font-semibold transition ${
                  eventMysteryMode
                    ? 'bg-[var(--mag-ink)] text-[var(--mag-bg)]'
                    : 'border border-[var(--mag-line)] bg-[var(--mag-card)] text-[var(--mag-ink-soft)] hover:bg-[var(--mag-surface)]'
                }`}
              >
                <Sparkles className="h-3.5 w-3.5" /> On
              </button>
              <button
                type="button"
                onClick={() => setEventMysteryMode(false)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-xs font-semibold transition ${
                  !eventMysteryMode
                    ? 'bg-[var(--mag-ink)] text-[var(--mag-bg)]'
                    : 'border border-[var(--mag-line)] bg-[var(--mag-card)] text-[var(--mag-ink-soft)] hover:bg-[var(--mag-surface)]'
                }`}
              >
                Off
              </button>
            </div>
            <p className="mt-1 text-center text-[10px] text-[var(--mag-ink-muted)]">
              Attendees' photos are blurred until they've exchanged 10 messages
            </p>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-[var(--mag-ink)]">Start Time</label>
            <div className="relative">
              <Calendar className="absolute left-3 top-3 h-4 w-4 text-[var(--mag-ink-muted)]" />
              <input
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                className="w-full rounded-2xl border border-[var(--mag-line)] bg-[var(--input-bg)] py-3 pl-10 pr-4 text-sm text-[var(--mag-ink)] focus:border-[var(--mag-ink)] focus:outline-none"
              />
            </div>
          </div>
        </div>

        {saveError && (
          <p className="mt-2 text-center text-xs font-semibold text-[var(--mag-sale)]">{saveError}</p>
        )}
        <div className="mt-4 flex items-center justify-center gap-3">
          <button
            onClick={handleSave}
            disabled={updateMutation.isPending}
            className="inline-flex w-full max-w-xs items-center justify-center gap-2 rounded-full bg-[var(--mag-ink)] py-2.5 text-xs font-bold text-[var(--mag-bg)] transition hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Save className="h-3.5 w-3.5" />
            {updateMutation.isPending ? 'Saving…' : 'Save Changes'}
          </button>
          {savedMsg && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--mag-ink)]">
              <CheckCircle2 className="h-3.5 w-3.5" /> Saved
            </span>
          )}
        </div>
      </section>

      {/* Event Controls */}
      <section className="mb-6 rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-3">
        <h2 className="mb-3 text-sm font-bold text-[var(--mag-ink)]">Event Controls</h2>
        <div className="flex flex-wrap items-center gap-3">
          {event.isActive ? (
            <button
              onClick={handleToggleActive}
              disabled={toggleActiveMutation.isPending}
              className="inline-flex items-center gap-2 rounded-full bg-[var(--mag-sale)] px-5 py-2.5 text-xs font-bold text-[var(--mag-bg)] transition hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Square className="h-3.5 w-3.5" /> Stop Event
            </button>
          ) : (
            <button
              onClick={handleToggleActive}
              disabled={toggleActiveMutation.isPending}
              className="inline-flex items-center gap-2 rounded-full bg-[var(--mag-ink)] px-5 py-2.5 text-xs font-bold text-[var(--mag-bg)] transition hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Play className="h-3.5 w-3.5" /> Start Event
            </button>
          )}

          <button
            onClick={handleDelete}
            disabled={deleteMutation.isPending}
            className="inline-flex items-center gap-2 rounded-full border border-[var(--mag-sale)]/30 bg-transparent px-5 py-2.5 text-xs font-bold text-[var(--mag-sale)] transition hover:bg-[var(--mag-sale-bg)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete Event
          </button>
        </div>
      </section>

      {/* Sponsor Branding */}
      {isCreator && (
        <section className="mb-6 rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-3">
          <h2 className="mb-3 text-sm font-bold text-[var(--mag-ink)]">Sponsor Branding</h2>

          {!(event as any)?.sponsorName && !(event as any)?.sponsorLogo && !(event as any)?.sponsorFrameUrl ? (
            <p className="mb-3 text-xs text-[var(--mag-ink-muted)]">
              Add sponsor branding
            </p>
          ) : (
            <div className="mb-3 flex items-center gap-3">
              {(event as any)?.sponsorLogo && (
                <img
                  src={(event as any).sponsorLogo}
                  alt={(event as any).sponsorName || 'Sponsor logo'}
                  className="h-8 max-w-[140px] object-contain"
                />
              )}
              <div className="min-w-0">
                {(event as any)?.sponsorName && (
                  <p className="text-xs font-semibold text-[var(--mag-ink)]">{(event as any).sponsorName}</p>
                )}
                {(event as any)?.sponsorFrameUrl && (
                  <p className="text-[10px] text-[var(--mag-ink-muted)]">Frame image set</p>
                )}
              </div>
            </div>
          )}

          <div className="mx-auto max-w-md space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-[var(--mag-ink)]">Sponsor Name</label>
              <input
                type="text"
                value={sponsorName}
                onChange={(e) => setSponsorName(e.target.value)}
                placeholder="e.g. Acme Corp"
                className="w-full rounded-2xl border border-[var(--mag-line)] bg-[var(--input-bg)] px-4 py-3 text-sm text-[var(--mag-ink)] focus:border-[var(--mag-ink)] focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-[var(--mag-ink)]">Sponsor Logo URL</label>
              <input
                type="url"
                value={sponsorLogo}
                onChange={(e) => setSponsorLogo(e.target.value)}
                placeholder="https://example.com/logo.png"
                className="w-full rounded-2xl border border-[var(--mag-line)] bg-[var(--input-bg)] px-4 py-3 text-sm text-[var(--mag-ink)] focus:border-[var(--mag-ink)] focus:outline-none"
              />
              {sponsorLogo && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-[10px] text-[var(--mag-ink-muted)]">Preview:</span>
                  <img src={sponsorLogo} alt="Logo preview" className="h-6 max-w-[120px] object-contain" />
                </div>
              )}
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-[var(--mag-ink)]">Sponsor Frame URL</label>
              <input
                type="url"
                value={sponsorFrameUrl}
                onChange={(e) => setSponsorFrameUrl(e.target.value)}
                placeholder="https://example.com/frame.png"
                className="w-full rounded-2xl border border-[var(--mag-line)] bg-[var(--input-bg)] px-4 py-3 text-sm text-[var(--mag-ink)] focus:border-[var(--mag-ink)] focus:outline-none"
              />
              <p className="mt-1 text-[10px] text-[var(--mag-ink-muted)]">
                A decorative border/frame image that wraps the event card
              </p>
            </div>
          </div>

          {sponsorError && (
            <p className="mt-2 text-center text-xs font-semibold text-[var(--mag-sale)]">{sponsorError}</p>
          )}

          <div className="mt-4 flex items-center justify-center gap-3">
            <button
              onClick={() => {
                updateSponsorMutation.mutate({
                  data: {
                    eventId,
                    sponsorName: sponsorName.trim() || undefined,
                    sponsorLogo: sponsorLogo.trim() || null,
                    sponsorFrameUrl: sponsorFrameUrl.trim() || null,
                  },
                })
              }}
              disabled={updateSponsorMutation.isPending}
              className="inline-flex w-full max-w-xs items-center justify-center gap-2 rounded-full bg-[var(--mag-ink)] py-2.5 text-xs font-bold text-[var(--mag-bg)] transition hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Save className="h-3.5 w-3.5" />
              {updateSponsorMutation.isPending ? 'Saving…' : 'Save Sponsor'}
            </button>
            {sponsorSaved && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--mag-ink)]">
                <CheckCircle2 className="h-3.5 w-3.5" /> Saved
              </span>
            )}
          </div>

          {((event as any)?.sponsorName || (event as any)?.sponsorLogo || (event as any)?.sponsorFrameUrl) && (
            <div className="mt-3 flex items-center justify-center">
              <button
                onClick={() => {
                  if (confirm('Remove sponsor branding from this event?')) {
                    removeSponsorMutation.mutate({ data: eventId })
                  }
                }}
                disabled={removeSponsorMutation.isPending}
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--mag-sale)]/30 px-4 py-2 text-[10px] font-bold text-[var(--mag-sale)] transition hover:bg-[var(--mag-sale-bg)] disabled:opacity-50"
              >
                <Trash2 className="h-3 w-3" /> Remove Sponsor
              </button>
            </div>
          )}
        </section>
      )}

      {/* Tabs */}
      <div className="mb-4 flex items-center gap-1 rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-1">
        {([
          { key: 'attendees', label: 'Attendees', count: attendeeCount, icon: Users },
          { key: 'activity', label: 'Activity', count: eventPosts.length, icon: MessageCircle },
          { key: 'waitlist', label: 'Waitlist', count: waitlist.length, icon: ListOrdered },
          { key: 'reports', label: 'Reports', count: reports.length, icon: Flag },
          { key: 'blocked', label: 'Blocked', count: blockedUsers.length, icon: Ban },
        ] as const).map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-semibold transition ${
              activeTab === t.key
                ? 'bg-[var(--mag-ink)] text-[var(--mag-bg)]'
                : 'text-[var(--mag-ink-soft)] hover:bg-[var(--mag-surface)]'
            }`}
          >
            <t.icon className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t.label}</span>
            <span className="rounded-full bg-white/20 px-1.5 py-0 text-[10px]">{t.count}</span>
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <section className="rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-3">
        {activeTab === 'attendees' && (
          <>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-bold text-[var(--mag-ink)]">Attendees</h2>
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--mag-surface)] px-2 py-0.5 text-[10px] font-semibold text-[var(--mag-ink)] border border-[var(--mag-line)]">
                <Users className="h-3 w-3" />
                {attendeeCount} total
              </span>
            </div>

            {profilesLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center gap-3 rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-surface)] p-3">
                    <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <Skeleton className="h-3 w-24 rounded-lg" />
                      <Skeleton className="h-2.5 w-32 rounded-lg" />
                    </div>
                    <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
                  </div>
                ))}
              </div>
            ) : attendeeProfiles.length === 0 ? (
              <p className="py-6 text-center text-xs text-[var(--mag-ink-muted)]">No attendees yet.</p>
            ) : (
              <div className="space-y-3">
                {attendeeProfiles.map((profile: any) => {
                  const photo = profile.photos?.[0]
                  return (
                    <div
                      key={profile.userId}
                      className="flex items-center gap-3 rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-surface)] p-3"
                    >
                      <div className="h-10 w-10 shrink-0 overflow-hidden rounded-full bg-[var(--mag-line)]">
                        <AvatarImage src={photo} alt={profile.name ?? ''} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-[var(--mag-ink)] flex items-center gap-1.5">
                          {profile.name ?? 'Unnamed'}
                          {profile.verifiedAt && <VerifiedBadge />}
                        </p>
                        <p className="truncate text-[10px] text-[var(--mag-ink-muted)]">
                          {profile.location ?? 'No location'}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          onClick={() => navigate({ to: '/chats/$chatId', params: { chatId: `org_${eventId}_${profile.userId}` } })}
                          title="Message"
                          className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--mag-surface)] text-[var(--mag-ink)] transition hover:bg-[var(--mag-line)]"
                        >
                          <MessageCircle className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => handleRemove(profile.userId, profile.name)}
                          title="Remove"
                          disabled={removeMutation.isPending}
                          className="flex h-8 w-8 items-center justify-center rounded-full bg-orange-500/10 text-orange-500 transition hover:bg-orange-500/20 disabled:opacity-50"
                        >
                          <UserX className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => handleBlock(profile.userId, profile.name)}
                          title="Block"
                          disabled={blockMutation.isPending}
                          className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--mag-sale)]/10 text-[var(--mag-sale)] transition hover:bg-[var(--mag-sale)]/20 disabled:opacity-50"
                        >
                          <Ban className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}

        {activeTab === 'activity' && (
          <>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-bold text-[var(--mag-ink)]">Activity Feed</h2>
            </div>
            <div className="rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] overflow-hidden">
              <div className="sticky top-0 bg-[var(--mag-card)] z-10 px-4 py-3 border-b border-[var(--mag-line)]">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={postContent}
                    onChange={(e) => setPostContent(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && postContent.trim()) {
                        e.preventDefault()
                        createPostMutation.mutate({ data: { eventId, content: postContent.trim() } })
                      }
                    }}
                    placeholder="Write something..."
                    className="flex-1 rounded-2xl border border-[var(--mag-line)] bg-[var(--input-bg)] px-4 py-2.5 text-sm text-[var(--mag-ink)] placeholder:text-[var(--mag-ink-muted)] focus:border-[var(--mag-ink)] focus:outline-none"
                  />
                  <button
                    onClick={() => {
                      if (postContent.trim()) {
                        createPostMutation.mutate({ data: { eventId, content: postContent.trim() } })
                      }
                    }}
                    disabled={!postContent.trim() || createPostMutation.isPending}
                    className="shrink-0 rounded-full bg-[var(--mag-ink)] px-4 py-2.5 text-xs font-bold text-[var(--mag-bg)] transition hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {createPostMutation.isPending ? 'Posting…' : 'Post'}
                  </button>
                </div>
              </div>
              <div className="max-h-[500px] overflow-y-auto">
                {postsLoading ? (
                  <div className="space-y-3 px-4 py-3">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="flex items-start gap-3">
                        <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <Skeleton className="h-3 w-24 rounded-lg" />
                          <Skeleton className="h-3 w-full rounded-lg" />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : eventPosts.length === 0 ? (
                  <p className="py-6 text-center text-xs text-[var(--mag-ink-muted)]">No posts yet. Start the conversation!</p>
                ) : (
                  eventPosts.map((post: any) => (
                    <div
                      key={post.id}
                      className="px-4 py-3 border-b border-[var(--mag-line)] last:border-b-0"
                    >
                      <div className="flex items-start gap-3">
                        <div className="h-9 w-9 shrink-0 overflow-hidden rounded-full bg-[var(--mag-line)]">
                          <AvatarImage src={post.author?.photo} alt={post.author?.name ?? ''} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="mb-0.5 flex items-center gap-2">
                            <span className="text-xs font-semibold text-[var(--mag-ink)]">{post.author?.name ?? 'Unnamed'}</span>
                            <span className="text-[10px] text-[var(--mag-ink-muted)]" suppressHydrationWarning>
                              {new Date(post.createdAt).toLocaleString()}
                            </span>
                          </div>
                          <p className="text-sm text-[var(--mag-ink)] whitespace-pre-wrap break-words">{post.content}</p>
                        </div>
                      </div>
                    </div>
                  ))
                )}
                {postsData?.nextCursor && (
                  <button
                    onClick={loadMorePosts}
                    className="w-full py-2 text-center text-xs font-medium text-[var(--mag-ink-muted)] transition hover:text-[var(--mag-ink)]"
                  >
                    Load more posts
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        {activeTab === 'waitlist' && (
          <>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-bold text-[var(--mag-ink)]">Waitlist</h2>
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--mag-surface)] px-2 py-0.5 text-[10px] font-semibold text-[var(--mag-ink)] border border-[var(--mag-line)]">
                <ListOrdered className="h-3 w-3" />
                {waitlist.length} waiting
              </span>
            </div>

            {waitlistLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center gap-3 rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-surface)] p-3">
                    <Skeleton className="h-6 w-6 shrink-0 rounded-full" />
                    <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <Skeleton className="h-3 w-24 rounded-lg" />
                      <Skeleton className="h-2.5 w-32 rounded-lg" />
                    </div>
                    <Skeleton className="h-7 w-16 shrink-0 rounded-full" />
                  </div>
                ))}
              </div>
            ) : waitlist.length === 0 ? (
              <p className="py-6 text-center text-xs text-[var(--mag-ink-muted)]">No one on the waitlist yet.</p>
            ) : (
              <div className="space-y-3">
                {waitlist.map((person: any, index: number) => (
                  <div
                    key={person.userId}
                    className="flex items-center gap-3 rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-surface)] p-3"
                  >
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--mag-line)] text-[10px] font-bold text-[var(--mag-ink-muted)]">
                      {index + 1}
                    </div>
                    <div className="h-10 w-10 shrink-0 overflow-hidden rounded-full bg-[var(--mag-line)]">
                      <AvatarImage src={person.photo} alt={person.name ?? ''} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-[var(--mag-ink)]">
                        {person.name ?? 'Unnamed'}
                      </p>
                      <p className="truncate text-[10px] text-[var(--mag-ink-muted)]">
                        Joined waitlist {new Date(person.joinedAt).toLocaleDateString()}
                      </p>
                    </div>
                    <button
                      onClick={() => handleRemoveWaitlist(person.userId, person.name)}
                      disabled={removeWaitlistMutation.isPending}
                      className="shrink-0 rounded-full border border-[var(--mag-line)] bg-[var(--mag-card)] px-3 py-1.5 text-[10px] font-medium text-[var(--mag-ink-soft)] transition hover:border-[var(--mag-sale)]/30 hover:text-[var(--mag-sale)] disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {activeTab === 'reports' && (
          <>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-bold text-[var(--mag-ink)]">Reports</h2>
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--mag-sale)]/10 px-2 py-0.5 text-[10px] font-semibold text-[var(--mag-sale)]">
                <ShieldAlert className="h-3 w-3" />
                {reports.length} total
              </span>
            </div>

            {reports.length === 0 ? (
              <p className="py-6 text-center text-xs text-[var(--mag-ink-muted)]">No reports yet.</p>
            ) : (
              <div className="space-y-3">
                {(reports as any[]).map((report) => (
                    <div key={report.id} className="rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-surface)] p-3">
                    <div className="mb-2 flex items-center gap-2">
                      <div className="h-8 w-8 shrink-0 overflow-hidden rounded-full bg-[var(--mag-line)]">
                        <AvatarImage src={(report.reported as any)?.photos?.[0]} alt="" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold text-[var(--mag-ink)]">
                          {(report.reported as any)?.name ?? 'Unknown'} reported by {(report.reporter as any)?.name ?? 'Unknown'}
                        </p>
                        <p className="text-[10px] text-[var(--mag-ink-muted)]" suppressHydrationWarning>
                          {new Date(report.createdAt).toLocaleString()}
                        </p>
                      </div>
                    </div>
                    <p className="rounded-lg bg-[var(--mag-card)] p-2 text-xs text-[var(--mag-ink-soft)]">
                      {report.reason}
                    </p>
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => handleBlock(report.reportedId, (report.reported as any)?.name)}
                        className="inline-flex items-center gap-1 rounded-full bg-[var(--mag-sale)] px-3 py-1.5 text-[10px] font-bold text-[var(--mag-bg)] transition hover:opacity-80"
                      >
                        <Ban className="h-3 w-3" /> Block user
                      </button>
                      <button
                        onClick={() => navigate({ to: '/chats/$chatId', params: { chatId: `org_${eventId}_${report.reportedId}` } })}
                        className="inline-flex items-center gap-1 rounded-full border border-[var(--mag-line)] bg-[var(--mag-card)] px-3 py-1.5 text-[10px] font-medium text-[var(--mag-ink)] transition hover:bg-[var(--mag-surface)]"
                      >
                        <MessageCircle className="h-3 w-3" /> Message
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {activeTab === 'blocked' && (
          <>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-bold text-[var(--mag-ink)]">Blocked Users</h2>
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--mag-sale)]/10 px-2 py-0.5 text-[10px] font-semibold text-[var(--mag-sale)]">
                <Ban className="h-3 w-3" />
                {blockedUsers.length} total
              </span>
            </div>

            {blockedUsers.length === 0 ? (
              <p className="py-6 text-center text-xs text-[var(--mag-ink-muted)]">No blocked users.</p>
            ) : (
              <div className="space-y-3">
                  {(blockedUsers as any[]).map((b) => {
                  const photo = b.profile?.photos?.[0]
                  return (
                    <div key={b.userId} className="flex items-center gap-3 rounded-xl border border-[var(--mag-line)] bg-[var(--mag-surface)] p-3">
                      <div className="h-10 w-10 shrink-0 overflow-hidden rounded-full bg-[var(--mag-line)]">
                        <AvatarImage src={photo} alt={b.profile?.name ?? ''} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-[var(--mag-ink)]">
                          {b.profile?.name ?? 'Unknown'}
                        </p>
                        <p className="truncate text-[10px] text-[var(--mag-ink-muted)]">
                          {b.reason || 'No reason given'}
                        </p>
                      </div>
                      <button
                        onClick={() => handleUnblock(b.userId)}
                        disabled={unblockMutation.isPending}
                        className="shrink-0 rounded-full border border-[var(--mag-line)] bg-[var(--mag-card)] px-3 py-1.5 text-[10px] font-medium text-[var(--mag-ink-soft)] transition hover:border-[var(--mag-ink)] hover:text-[var(--mag-ink)] disabled:opacity-50"
                      >
                        Unblock
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </section>


    </main>
  )
}
