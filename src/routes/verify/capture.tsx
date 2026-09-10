import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowLeft, Camera, CheckCircle, Clock, RefreshCw, ShieldAlert } from 'lucide-react'
import { getMyVerificationStatus, submitPhotoVerification } from '#/server/profiles'

export const Route = createFileRoute('/verify/capture')({ component: VerifyCapturePage })

/**
 * Real capture flow.
 *
 * This page used to be four useState steps with a "Simulate success" button
 * that never contacted the server — while the server endpoint behind it handed
 * out the verified badge to anyone who posted any image. Submitting now queues
 * the photo for review; only an admin can grant the badge.
 */
function VerifyCapturePage() {
  const navigate = useNavigate()
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const [step, setStep] = useState<'pose' | 'capture' | 'review' | 'submitted'>('pose')
  const [capture, setCapture] = useState<string | null>(null)
  const [cameraError, setCameraError] = useState('')

  const { data: status } = useQuery({
    queryKey: ['verification-status'],
    queryFn: () => getMyVerificationStatus(),
  })

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }, [])

  const startCamera = useCallback(async () => {
    setCameraError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 960 } },
        audio: false,
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      setStep('capture')
    } catch {
      setCameraError('We could not access your camera. Check your browser permissions and try again.')
    }
  }, [])

  useEffect(() => stopCamera, [stopCamera])

  const takePhoto = () => {
    const video = videoRef.current
    if (!video) return

    const canvas = document.createElement('canvas')
    // Cap the long edge so the upload stays well inside the server's size limit.
    const scale = Math.min(1, 1000 / Math.max(video.videoWidth, video.videoHeight))
    canvas.width = Math.round(video.videoWidth * scale)
    canvas.height = Math.round(video.videoHeight * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

    setCapture(canvas.toDataURL('image/jpeg', 0.85))
    stopCamera()
    setStep('review')
  }

  const submitMutation = useMutation({
    mutationFn: submitPhotoVerification,
    onSuccess: (res) => {
      if (res.success) setStep('submitted')
    },
  })

  const retake = () => {
    setCapture(null)
    void startCamera()
  }

  const alreadyHandled = status?.verifiedAt || status?.status === 'pending'

  return (
    <div className="page-wrap flex min-h-[90vh] flex-col px-4 py-4">
      <div className="mb-4 flex items-center gap-2">
        <button
          onClick={() => {
            stopCamera()
            history.back()
          }}
          className="rounded-full p-2 text-[var(--mag-ink-soft)] hover:bg-[var(--mag-surface)]"
          aria-label="Go back"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-lg font-bold text-[var(--mag-ink)]">Photo Verification</h1>
      </div>

      {alreadyHandled && step !== 'submitted' && (
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-[var(--mag-surface)]">
            {status?.verifiedAt ? (
              <CheckCircle className="h-10 w-10 text-[var(--mag-success)]" />
            ) : (
              <Clock className="h-10 w-10 text-[var(--mag-ink-soft)]" />
            )}
          </div>
          <h2 className="text-2xl font-bold text-[var(--mag-ink)]">
            {status?.verifiedAt ? 'You are verified' : 'Review in progress'}
          </h2>
          <p className="mt-2 max-w-xs text-sm text-[var(--mag-ink-soft)]">
            {status?.verifiedAt
              ? 'Your badge is live on your profile.'
              : 'We have your photo. A moderator reviews each submission — we will notify you when it is done.'}
          </p>
          <button
            onClick={() => navigate({ to: '/profile' })}
            className="mx-auto mt-8 flex w-full max-w-sm items-center justify-center rounded-full bg-[var(--mag-ink)] px-6 py-3 text-sm font-medium text-[var(--mag-bg)] transition hover:opacity-80 active:scale-95"
          >
            Back to Profile
          </button>
        </div>
      )}

      {!alreadyHandled && step === 'pose' && (
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <div className="mb-6 rounded-3xl border-4 border-dashed border-[var(--mag-line)] bg-[var(--mag-surface)] p-12">
            <div className="text-6xl font-bold text-[var(--mag-ink-muted)]">✌</div>
          </div>
          <h2 className="text-lg font-bold text-[var(--mag-ink)]">Strike a pose</h2>
          <p className="mt-2 max-w-xs text-sm text-[var(--mag-ink-soft)]">
            Hold up two fingers next to your face, like the example above. A moderator compares this
            with your profile photos.
          </p>
          {status?.status === 'rejected' && (
            <p className="mt-3 max-w-xs text-xs text-[var(--mag-sale)]">
              Your last submission was not approved. Make sure your face and both fingers are clearly
              visible.
            </p>
          )}
          {cameraError && (
            <p className="mt-3 max-w-xs text-xs text-[var(--mag-sale)]">{cameraError}</p>
          )}
          <button
            onClick={() => void startCamera()}
            className="mx-auto mt-8 flex w-full max-w-sm items-center justify-center rounded-full bg-[var(--mag-ink)] px-6 py-3 text-sm font-medium text-[var(--mag-bg)] transition hover:opacity-80 active:scale-95"
          >
            I am Ready
          </button>
        </div>
      )}

      {!alreadyHandled && step === 'capture' && (
        <div className="flex flex-1 flex-col items-center">
          <div className="relative mx-auto aspect-[3/4] w-full max-w-sm overflow-hidden rounded-3xl bg-gray-900">
            <video
              ref={videoRef}
              playsInline
              muted
              className="h-full w-full object-cover"
              style={{ transform: 'scaleX(-1)' }}
            />
            <div className="pointer-events-none absolute inset-0 rounded-3xl border-4 border-white/20" />
            <p className="pointer-events-none absolute top-6 left-0 right-0 text-center text-sm font-medium text-white">
              Position your face in the frame
            </p>
          </div>
          <button
            onClick={takePhoto}
            className="mt-6 flex h-16 w-16 items-center justify-center rounded-full bg-[var(--mag-ink)] transition hover:scale-105"
            aria-label="Take photo"
          >
            <Camera className="h-7 w-7 text-white" />
          </button>
        </div>
      )}

      {!alreadyHandled && step === 'review' && capture && (
        <div className="flex flex-1 flex-col items-center">
          <div className="relative mx-auto aspect-[3/4] w-full max-w-sm overflow-hidden rounded-3xl bg-[var(--mag-surface)]">
            <img src={capture} alt="Your verification photo" className="h-full w-full object-cover" />
          </div>

          {submitMutation.isError && (
            <p className="mt-3 text-xs text-[var(--mag-sale)]">
              {(submitMutation.error as Error)?.message || 'Upload failed. Please try again.'}
            </p>
          )}
          {submitMutation.data && !submitMutation.data.success && (
            <p className="mt-3 text-xs text-[var(--mag-sale)]">{submitMutation.data.message}</p>
          )}

          <div className="mt-6 flex w-full max-w-sm gap-2">
            <button
              onClick={retake}
              disabled={submitMutation.isPending}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-full border border-[var(--mag-line)] bg-[var(--mag-card)] py-3 text-sm font-medium text-[var(--mag-ink)] transition hover:bg-[var(--mag-surface)] disabled:opacity-50"
            >
              <RefreshCw className="h-4 w-4" /> Retake
            </button>
            <button
              onClick={() => submitMutation.mutate({ data: { imageBase64: capture } })}
              disabled={submitMutation.isPending}
              className="flex flex-1 items-center justify-center rounded-full bg-[var(--mag-ink)] py-3 text-sm font-bold text-[var(--mag-bg)] transition hover:opacity-80 active:scale-95 disabled:opacity-50"
            >
              {submitMutation.isPending ? 'Submitting…' : 'Submit for review'}
            </button>
          </div>
        </div>
      )}

      {step === 'submitted' && (
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-[var(--mag-surface)]">
            <ShieldAlert className="h-10 w-10 text-[var(--mag-ink)]" />
          </div>
          <h2 className="text-2xl font-bold text-[var(--mag-ink)]">Submitted for review</h2>
          <p className="mt-2 max-w-xs text-sm text-[var(--mag-ink-soft)]">
            A moderator will compare your photo with your profile. You will get a notification when
            your badge is approved.
          </p>
          <button
            onClick={() => navigate({ to: '/profile' })}
            className="mx-auto mt-8 flex w-full max-w-sm items-center justify-center rounded-full bg-[var(--mag-ink)] px-6 py-3 text-sm font-medium text-[var(--mag-bg)] transition hover:opacity-80 active:scale-95"
          >
            Back to Profile
          </button>
        </div>
      )}
    </div>
  )
}
