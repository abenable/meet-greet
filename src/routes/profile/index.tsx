import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Skeleton } from '@heroui/react'
import { MapPin, Camera, Link2, Pencil, AlertTriangle, Sparkles, Heart, Users, Briefcase, Flame, Calendar, BadgeCheck, Zap, Plus } from 'lucide-react'
import { getMyProfile, updateProfile } from '#/server/profiles'
import { disableMyAccount } from '#/server/auth'
import { getUserBadges, getUserStreak } from '#/server/badges'
import { activateBoost, getBoostStatus } from '#/server/boosts'
import AvatarImage from '#/components/AvatarImage'
import { uploadImageToR2, maybeDeleteR2Image } from '#/lib/upload'

export const Route = createFileRoute('/profile/')({ component: ProfilePage })

const BADGE_CONFIG: Record<string, { label: string; icon: React.ElementType; className: string }> = {
  first_match: { label: 'First Match', icon: Heart, className: 'bg-[var(--mag-surface)] text-[var(--mag-ink)] border border-[var(--mag-line)]' },
  streak_3: { label: '3 Day Streak', icon: Flame, className: 'bg-[var(--mag-surface)] text-[var(--mag-ink)] border border-[var(--mag-line)]' },
  streak_7: { label: '7 Day Streak', icon: Flame, className: 'bg-[var(--mag-surface)] text-[var(--mag-ink)] border border-[var(--mag-line)]' },
  social_butterfly: { label: 'Social Butterfly', icon: Users, className: 'bg-[var(--mag-surface)] text-[var(--mag-ink)] border border-[var(--mag-line)]' },
  event_host: { label: 'Event Host', icon: Calendar, className: 'bg-[var(--mag-surface)] text-[var(--mag-ink)] border border-[var(--mag-line)]' },
  verified: { label: 'Verified', icon: BadgeCheck, className: 'bg-[var(--mag-ink)] text-[var(--mag-bg)]' },
  ice_breaker: { label: 'Ice Breaker', icon: Sparkles, className: 'bg-[var(--mag-surface)] text-[var(--mag-ink)] border border-[var(--mag-line)]' },
}

function ProfilePage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const fileRef = useRef<HTMLInputElement>(null)
  const { data: profile } = useQuery({ queryKey: ['my-profile'], queryFn: () => getMyProfile() })
  const { data: badges } = useQuery({ queryKey: ['my-badges'], queryFn: () => getUserBadges() })
  const { data: streakData } = useQuery({ queryKey: ['my-streak'], queryFn: () => getUserStreak() })

  const [editingField, setEditingField] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editGender, setEditGender] = useState('')
  const [uploadingAvatar, setUploadingAvatar] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(false)

  const { data: boostStatus } = useQuery({ queryKey: ['boost-status'], queryFn: () => getBoostStatus() })
  const [boostCountdown, setBoostCountdown] = useState('')
  const [cooldownCountdown, setCooldownCountdown] = useState('')

  useEffect(() => {
    const tick = () => {
      if (boostStatus?.boostedUntil) {
        const diff = new Date(boostStatus.boostedUntil).getTime() - Date.now()
        if (diff > 0) {
          const mins = Math.floor(diff / 60000)
          const secs = Math.floor((diff % 60000) / 1000)
          setBoostCountdown(`${mins}m ${secs}s`)
        } else {
          setBoostCountdown('')
        }
      }
      if (boostStatus?.nextBoostAt) {
        const diff = new Date(boostStatus.nextBoostAt).getTime() - Date.now()
        if (diff > 0) {
          const hours = Math.floor(diff / 3600000)
          const mins = Math.floor((diff % 3600000) / 60000)
          setCooldownCountdown(`${hours}h ${mins}m`)
        } else {
          setCooldownCountdown('')
        }
      }
    }
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [boostStatus])

  const boostMutation = useMutation({
    mutationFn: async () => {
      await activateBoost()
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['boost-status'] })
      qc.invalidateQueries({ queryKey: ['my-profile'] })
    },
  })

  const updateMutation = useMutation({
    mutationFn: async (updates: any) => {
      await updateProfile({ data: updates })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-profile'] })
      setEditingField(null)
    },
  })

  const logoutMutation = useMutation({
    mutationFn: async () => {
      const { authClient } = await import('#/lib/auth-client')
      await authClient.signOut()
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session'] })
      window.location.href = '/login'
    },
  })

  const disableMutation = useMutation({
    mutationFn: async () => {
      await disableMyAccount()
    },
    onSuccess: () => {
      window.location.href = '/'
    },
  })

  const openEdit = (field: string, current: string, gender?: string) => {
    setEditingField(field)
    setEditValue(current)
    if (gender) setEditGender(gender)
  }

  const saveEdit = () => {
    if (!editingField || !profile) return
    const updates: any = {}
    if (editingField === 'name') {
      updates.name = editValue
      updates.gender = editGender
    }
    if (editingField === 'bio') updates.bio = editValue
    if (editingField === 'location') updates.location = editValue
    updateMutation.mutate(updates)
  }

  const handleAvatarFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !profile) return
    setUploadingAvatar(true)
    try {
      const key = `profiles/${profile.userId}/avatar-${crypto.randomUUID()}.jpg`
      const url = await uploadImageToR2(file, key, 600)

      const oldAvatar = (profile.photos || [])[0]
      if (oldAvatar?.startsWith('http')) {
        await maybeDeleteR2Image(oldAvatar).catch(() => {})
      }

      const photos = [url, ...(profile.photos || []).slice(1)]
      await updateProfile({ data: { photos } })
      qc.invalidateQueries({ queryKey: ['my-profile'] })
    } catch {
      // silently fail
    } finally {
      setUploadingAvatar(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  if (!profile) {
    return (
      <div className="page-wrap flex flex-1 flex-col px-4 py-4">
        <div className="mb-4 flex flex-col items-center">
          <Skeleton className="h-28 w-28 rounded-full" />
          <Skeleton className="mt-3 h-6 w-32 rounded-lg" />
          <Skeleton className="mt-1 h-4 w-24 rounded-lg" />
          <div className="mt-2 flex gap-2">
            <Skeleton className="h-7 w-20 rounded-full" />
            <Skeleton className="h-7 w-20 rounded-full" />
          </div>
          <Skeleton className="mt-3 h-7 w-32 rounded-full" />
        </div>
        <div className="mb-5 flex flex-wrap justify-center gap-2">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-7 w-20 rounded-full" />
          ))}
        </div>
        <Skeleton className="mb-4 h-24 w-full rounded-2xl" />
        <Skeleton className="mb-4 h-20 w-full rounded-2xl" />
        <Skeleton className="mb-4 h-28 w-full rounded-2xl" />
        <div className="mb-4 grid grid-cols-2 gap-3">
          <Skeleton className="h-12 w-full rounded-full" />
          <Skeleton className="h-12 w-full rounded-full" />
        </div>
      </div>
    )
  }

  const avatarPhoto = (profile.photos || [])[0]
  const photoCount = (profile.photos || []).length

  return (
    <div className="page-wrap flex flex-1 flex-col px-4 py-4">
      {/* Profile Avatar */}
      <div className="mb-4 flex flex-col items-center">
        <div className={`relative h-28 w-28 overflow-hidden rounded-full border-4 ${boostStatus?.isBoosted ? 'border-[var(--mag-ink)]' : 'border-[var(--mag-card)]'}`}>
          <AvatarImage src={avatarPhoto} alt="Profile" />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploadingAvatar}
            className="absolute bottom-0 right-0 flex h-8 w-8 items-center justify-center rounded-full bg-[var(--mag-ink)] text-[var(--mag-bg)] transition hover:opacity-80 disabled:opacity-60"
          >
            {uploadingAvatar ? (
              <div className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--mag-bg)] border-t-transparent" />
            ) : (
              <Camera className="h-4 w-4" />
            )}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleAvatarFile}
          />
        </div>

        <div className="mt-3 flex items-center gap-2">
          <h2 className="text-xl font-bold text-[var(--mag-ink)]">{profile.name || 'You'}</h2>
        </div>

        <div className="mt-1 inline-flex items-center gap-1 text-sm text-[var(--mag-ink-soft)]">
          <MapPin className="h-3.5 w-3.5" />
          <span>{profile.location || 'Add your location'}</span>
        </div>

        {profile.lookingFor && profile.lookingFor.length > 0 && (
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            {profile.lookingFor.map((intent) => (
              <span
                key={intent}
                className="inline-flex items-center gap-1 rounded-full border border-[var(--mag-line)] bg-[var(--mag-surface)] px-3 py-1 text-xs font-medium text-[var(--mag-ink)]"
              >
                {intent === 'dating' && <Heart className="h-3 w-3" />}
                {intent === 'friends' && <Users className="h-3 w-3" />}
                {intent === 'networking' && <Briefcase className="h-3 w-3" />}
                {intent.charAt(0).toUpperCase() + intent.slice(1)}
              </span>
            ))}
          </div>
        )}

        {streakData && streakData.streakCount > 1 && (
          <div className="mt-2 inline-flex items-center gap-1 rounded-full border border-[var(--mag-line)] bg-[var(--mag-surface)] px-3 py-1 text-xs font-medium text-[var(--mag-ink)]">
            <Flame className="h-3 w-3" />
            <span>{streakData.streakCount} day streak</span>
          </div>
        )}

        {/* Boost — prominent when active */}
        {boostStatus?.isBoosted ? (
          <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-[var(--mag-ink)] px-4 py-1.5 text-xs font-bold text-[var(--mag-bg)]">
            <Zap className="h-3.5 w-3.5 fill-current" />
            <span>Profile Boosted</span>
            {boostCountdown && <span className="font-mono opacity-80">{boostCountdown}</span>}
          </div>
        ) : (
          <button
            onClick={() => boostMutation.mutate()}
            disabled={boostMutation.isPending || !!cooldownCountdown}
            className={`mt-3 inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-medium transition ${
              cooldownCountdown
                ? 'bg-[var(--mag-surface)] text-[var(--mag-ink-muted)]'
                : 'bg-[var(--mag-ink)] text-[var(--mag-bg)] hover:opacity-80'
            } disabled:opacity-60`}
          >
            <Zap className="h-3.5 w-3.5" />
            {boostMutation.isPending
              ? 'Activating...'
              : cooldownCountdown
                ? `Boost in ${cooldownCountdown}`
                : 'Boost Profile'}
          </button>
        )}

      </div>

      {/* Interests */}
      <div className="mb-5 flex flex-wrap justify-center gap-2">
        {(profile.interests || []).map((interest: string) => (
          <span key={interest} className="rounded-full border border-[var(--mag-line)] bg-[var(--mag-card)] px-3 py-1.5 text-xs font-medium text-[var(--mag-ink)]">{interest}</span>
        ))}
      </div>

      {/* My Photos */}
      <button
        onClick={() => navigate({ to: '/profile/media' })}
        className="mb-4 flex w-full flex-col rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-3 text-left transition hover:border-[var(--mag-ink)]/20"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[var(--mag-ink)]">My Photos</h3>
          <span className="text-xs text-[var(--mag-ink-muted)]">{photoCount} photo{photoCount !== 1 ? 's' : ''}</span>
        </div>

        {photoCount > 0 ? (
          <div className="flex items-center gap-2 overflow-x-auto hide-scrollbar">
            {(profile.photos || []).slice(0, 5).map((photo: string, i: number) => (
              <div key={i} className="h-20 w-20 flex-shrink-0 overflow-hidden rounded-xl">
                <img src={photo} alt={`Photo ${i + 1}`} className="h-full w-full object-cover" />
              </div>
            ))}
            <div className="flex h-20 w-20 flex-shrink-0 items-center justify-center border border-dashed border-[var(--mag-line)] bg-[var(--mag-surface)]">
              <Plus className="h-6 w-6 text-[var(--mag-ink-muted)]" />
            </div>
          </div>
        ) : (
          <div className="flex h-24 items-center justify-center border border-dashed border-[var(--mag-line)] bg-[var(--mag-surface)]">
            <span className="text-sm text-[var(--mag-ink-muted)]">Tap to add photos</span>
          </div>
        )}

      </button>

      {/* About Me */}
      <button
        onClick={() => openEdit('bio', profile.bio || '')}
        className="mb-4 flex w-full items-start justify-between rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-3 text-left transition hover:border-[var(--mag-ink)]/20"
      >
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-[var(--mag-ink)]">About Me</h3>
          <p className="mt-1 text-sm leading-relaxed text-[var(--mag-ink-soft)]">
            {profile.bio || <span className="text-[var(--mag-ink-muted)]">Tell people about yourself — interests, hobbies, what you're looking for…</span>}
          </p>
        </div>
        <Pencil className="ml-3 mt-0.5 h-4 w-4 shrink-0 text-[var(--mag-ink-muted)]" />
      </button>

      {/* Badges */}
      {badges && badges.length > 0 && (
        <div className="mb-4 rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-3">
          <h3 className="mb-2 text-sm font-semibold text-[var(--mag-ink)]">Badges</h3>
          <div className="flex flex-wrap gap-2">
            {badges.map((badge) => {
              const config = BADGE_CONFIG[badge.type]
              if (!config) return null
              const Icon = config.icon
              return (
                <span
                  key={badge.id}
                  className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium ${config.className}`}
                >
                  <Icon className="h-3 w-3" />
                  {config.label}
                </span>
              )
            })}
          </div>
        </div>
      )}

      {/* Location */}
      <button
        onClick={() => openEdit('location', profile.location || '')}
        className="mb-4 flex w-full items-start justify-between rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-3 text-left transition hover:border-[var(--mag-ink)]/20"
      >
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-[var(--mag-ink)]">Location</h3>
          <div className="mt-1 flex items-center gap-2 text-sm text-[var(--mag-ink-soft)]">
            <MapPin className="h-4 w-4 text-[var(--mag-ink-muted)]" />
            <span>{profile.location || 'Add your location'}</span>
          </div>
        </div>
        <Pencil className="ml-3 mt-0.5 h-4 w-4 shrink-0 text-[var(--mag-ink-muted)]" />
      </button>

      {/* Action buttons */}
      <div className="mb-4">
        <button
          onClick={() => {
            const link = `${window.location.origin}/events/join/${profile.userId}`
            navigator.clipboard.writeText(link)
          }}
          className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-[var(--mag-line)] bg-[var(--mag-card)] px-4 py-3 text-sm font-medium text-[var(--mag-ink)] transition hover:bg-[var(--mag-surface)]"
        >
          <Link2 className="h-4 w-4" />
          Share Profile
        </button>
      </div>

      {/* Log Out — neutral, not danger */}
      <button
        onClick={() => logoutMutation.mutate()}
        disabled={logoutMutation.isPending}
        className="mb-6 inline-flex w-full items-center justify-center gap-2 rounded-full border border-[var(--mag-line)] bg-[var(--mag-card)] py-3 text-sm font-medium text-[var(--mag-ink-soft)] transition hover:bg-[var(--mag-surface)] hover:text-[var(--mag-ink)] disabled:opacity-60"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
        </svg>
        Log Out
      </button>

      {/* Delete Account */}
      <div className="mb-8 border-t border-[var(--mag-line)] pt-4 text-center">
        <button
          onClick={() => setShowDeleteModal(true)}
          className="inline-flex items-center justify-center gap-2 rounded-full border border-[var(--mag-sale)]/30 bg-[var(--mag-sale)]/10 px-6 py-2.5 text-sm font-semibold text-[var(--mag-sale)] transition hover:bg-[var(--mag-sale)]/20"
        >
          <AlertTriangle className="h-4 w-4" />
          Delete Account
        </button>
        <p className="mt-2 text-[10px] text-[var(--mag-ink-muted)]">
          Your account will be disabled and you will no longer appear anywhere in the app.
        </p>
      </div>

      {/* Delete Account Modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-sm rounded-2xl bg-[var(--mag-card)] p-5 border border-[var(--mag-line)]">
            <div className="mb-3 flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-[var(--mag-sale)]" />
              <h3 className="text-sm font-semibold text-[var(--mag-ink)]">Delete Account</h3>
            </div>
            <p className="mb-4 text-sm text-[var(--mag-ink-soft)]">
              Are you sure? This will disable your account, remove you from all events, and you will no longer be visible to anyone. Your email will be permanently blocked from re-registration.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setShowDeleteModal(false)}
                className="flex-1 rounded-full border border-[var(--mag-line)] bg-[var(--mag-bg)] py-2.5 text-sm font-medium text-[var(--mag-ink)] transition hover:bg-[var(--mag-surface)]"
              >
                Cancel
              </button>
              <button
                onClick={() => disableMutation.mutate()}
                disabled={disableMutation.isPending}
                className="flex-1 rounded-full bg-[var(--mag-sale)] py-2.5 text-sm font-semibold text-[var(--mag-bg)] transition hover:bg-[var(--mag-sale-deep)] disabled:opacity-60"
              >
                {disableMutation.isPending ? 'Deleting…' : 'Delete Account'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editingField && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-2xl bg-[var(--mag-card)] p-5 border border-[var(--mag-line)]">
            <h3 className="mb-3 text-sm font-semibold text-[var(--mag-ink)]">
              {editingField === 'name' ? 'Edit Profile' : editingField === 'bio' ? 'About Me' : 'Location'}
            </h3>
            {editingField === 'name' && (
              <div className="mb-3">
                <label className="mb-1.5 block text-xs font-medium text-[var(--mag-ink-soft)]">Display Name</label>
                <input
                  type="text"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  placeholder="Your name"
                  className="w-full rounded-2xl border border-[var(--mag-line)] bg-[var(--input-bg)] px-4 py-3 text-sm text-[var(--mag-ink)] focus:border-[var(--mag-ink)] focus:outline-none"
                />
              </div>
            )}
            {editingField !== 'name' && (
              <textarea value={editValue} onChange={(e) => setEditValue(e.target.value)} rows={editingField === 'bio' ? 4 : 1}
                className="mb-4 w-full resize-none rounded-2xl border border-[var(--mag-line)] bg-[var(--input-bg)] p-3 text-sm text-[var(--mag-ink)] focus:border-[var(--mag-ink)] focus:outline-none" />
            )}
            {editingField === 'name' && (
              <div className="mb-4">
                <label className="mb-1.5 block text-xs font-medium text-[var(--mag-ink-soft)]">Gender</label>
                <select
                  value={editGender}
                  onChange={(e) => setEditGender(e.target.value)}
                  className="w-full rounded-2xl border border-[var(--mag-line)] bg-[var(--input-bg)] px-4 py-3 text-sm text-[var(--mag-ink)] focus:border-[var(--mag-ink)] focus:outline-none"
                >
                  <option value="">Select gender</option>
                  <option value="Male">Male</option>
                  <option value="Female">Female</option>
                </select>
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={() => setEditingField(null)} className="flex-1 rounded-full border border-[var(--mag-line)] bg-[var(--mag-bg)] py-2.5 text-sm font-medium text-[var(--mag-ink)] transition hover:bg-[var(--mag-surface)]">Cancel</button>
              <button onClick={saveEdit} disabled={updateMutation.isPending} className="flex-1 rounded-full bg-[var(--mag-ink)] py-2.5 text-sm font-semibold text-[var(--mag-bg)] transition hover:opacity-80 disabled:opacity-60">{updateMutation.isPending ? 'Saving...' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}


    </div>
  )
}
