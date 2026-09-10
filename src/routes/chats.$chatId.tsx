import { createFileRoute, useParams, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Skeleton } from '@heroui/react'
import { ArrowLeft, Send, Check, CheckCheck, Ban, Mic, Play, Pause, Square, X } from 'lucide-react'
import { getChatMessages, sendChatMessage, markChatRead, getIcebreakers, uploadVoiceMessage } from '#/server/conversations'
import { getProfileByUserId } from '#/server/profiles'
import { blockUser } from '#/server/blocks'
import AvatarImage from '#/components/AvatarImage'
import { VerifiedBadge } from '#/components/VerifiedBadge'
import { useChatWebSocket } from '#/hooks/useWebSocket'

export const Route = createFileRoute('/chats/$chatId')({ component: UnifiedChatPage })

function formatDuration(seconds: number) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function VoiceMessagePlayer({ url, isMine }: { url: string; isMine: boolean }) {
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    const audio = new Audio()
    audio.preload = 'metadata'
    audio.src = url
    audioRef.current = audio
    audio.onloadedmetadata = () => setDuration(audio.duration)
    audio.onended = () => setPlaying(false)
    audio.ontimeupdate = () => setCurrentTime(audio.currentTime)
    return () => {
      audio.pause()
      audio.src = ''
      audioRef.current = null
    }
  }, [url])

  const toggle = () => {
    if (!audioRef.current) return
    if (playing) {
      audioRef.current.pause()
      setPlaying(false)
    } else {
      audioRef.current.play()
      setPlaying(true)
    }
  }

  return (
    <div className={`inline-flex items-center gap-2 rounded-2xl px-4 py-2 ${isMine ? 'bg-[var(--mag-ink)] text-[var(--mag-bg)]' : 'border border-[var(--mag-line)] bg-[var(--mag-surface)] text-[var(--mag-ink)]'}`}>
      <button
        onClick={toggle}
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${isMine ? 'bg-white/20 text-white' : 'bg-[var(--mag-line)] text-[var(--mag-ink)]'}`}
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </button>
      <span className="min-w-[3rem] text-xs font-medium">{playing ? formatDuration(currentTime) : formatDuration(duration)}</span>
      {/* No second <audio> element here: it duplicated the download of every
          voice clip, since playback runs entirely through the Audio object
          created above. */}
    </div>
  )
}

function UnifiedChatPage() {
  const { chatId } = useParams({ from: '/chats/$chatId' })
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [blockDialogOpen, setBlockDialogOpen] = useState(false)
  const [showRevealToast, setShowRevealToast] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const typingTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined)
  const prevUnlockedRef = useRef<boolean | undefined>(undefined)

  // Voice recording state
  const [isRecording, setIsRecording] = useState(false)
  const [recordingDuration, setRecordingDuration] = useState(0)
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Use WebSocket for real-time updates
  const { connected, sendTyping, typingUsers } = useChatWebSocket(chatId)

  // The newest page. Older history is fetched on demand into `olderMessages`
  // below — without that, paginating the server silently truncated every
  // conversation to its most recent 50 messages with no way to scroll back.
  const { data: chatData, isLoading, error } = useQuery({
    queryKey: ['chat', chatId],
    queryFn: () => getChatMessages({ data: { chatId } }),
    // Keep a slow poll even when the socket is up. Disabling it on `connected`
    // meant a socket that connected but delivered nothing left the thread
    // frozen with no fallback — which is exactly what happened while the
    // server never subscribed anyone to their own user topic.
    refetchInterval: connected ? 30000 : 5000,
    refetchOnWindowFocus: true,
  })

  type ChatMessage = NonNullable<typeof chatData>['messages'][number]
  const [olderMessages, setOlderMessages] = useState<ChatMessage[]>([])
  const [olderCursor, setOlderCursor] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)

  // Reset paged-in history when switching conversations.
  useEffect(() => {
    setOlderMessages([])
    setOlderCursor(null)
  }, [chatId])

  const hasOlder = (olderCursor ?? chatData?.nextCursor ?? null) !== null

  const loadOlder = async () => {
    const cursor = olderCursor ?? chatData?.nextCursor ?? null
    if (!cursor || loadingOlder) return
    setLoadingOlder(true)
    try {
      const page = await getChatMessages({ data: { chatId, before: cursor } })
      setOlderMessages((prev) => [...page.messages, ...prev])
      setOlderCursor(page.nextCursor ?? null)
    } catch {
      // Leave the button available to retry.
    } finally {
      setLoadingOlder(false)
    }
  }

  // Deduplicate in case a poll refetch overlaps a page already loaded.
  const messages = useMemo(() => {
    const seen = new Set<string>()
    return [...olderMessages, ...(chatData?.messages ?? [])].filter((m) => {
      if (seen.has(m.id)) return false
      seen.add(m.id)
      return true
    })
  }, [olderMessages, chatData?.messages])

  const peerId = chatData?.peerId ?? ''

  const { data: peerProfile } = useQuery({
    queryKey: ['profile', peerId],
    queryFn: () => getProfileByUserId({ data: peerId }),
    enabled: !!peerId,
  })

  const blockMutation = useMutation({
    mutationFn: blockUser,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversations'] })
      qc.invalidateQueries({ queryKey: ['matches'] })
      qc.invalidateQueries({ queryKey: ['blocked-users'] })
      navigate({ to: '/chats' })
    },
  })

  const matchId = chatId.startsWith('match_') ? chatId.slice('match_'.length) : null
  const isPhotosLocked = !!matchId && !chatData?.messagesUnlockedAt
  const remainingMessages = isPhotosLocked ? Math.max(0, 10 - (chatData?.messages.length ?? 0)) : 0
  const { data: icebreakers } = useQuery({
    queryKey: ['icebreakers', matchId],
    queryFn: () => getIcebreakers({ data: matchId! }),
    enabled: !!matchId && (chatData?.messages.length ?? 0) < 3,
  })

  useEffect(() => {
    if (!chatId) return
    markChatRead({ data: chatId }).then(() => {
      qc.invalidateQueries({ queryKey: ['conversations'] })
    })
  }, [chatId, qc])

  // Detect photo unlock for mystery mode toast
  useEffect(() => {
    const isNowUnlocked = !!chatData?.messagesUnlockedAt
    if (prevUnlockedRef.current === false && isNowUnlocked) {
      setShowRevealToast(true)
      setTimeout(() => setShowRevealToast(false), 3000)
    }
    prevUnlockedRef.current = isNowUnlocked
  }, [chatData?.messagesUnlockedAt])

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatData?.messages])

  // Recording timer
  useEffect(() => {
    if (isRecording) {
      recordingTimerRef.current = setInterval(() => {
        setRecordingDuration((d) => {
          if (d >= 59) {
            mediaRecorderRef.current?.stop()
            return d
          }
          return d + 1
        })
      }, 1000)
    } else {
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current)
    }
    return () => {
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current)
    }
  }, [isRecording])

  // Handle typing indicator
  const handleInputChange = (value: string) => {
    setInput(value)
    
    // Send typing indicator
    if (connected) {
      sendTyping(chatId, true)
      
      // Clear existing timeout
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current)
      }
      
      // Stop typing after 2 seconds of inactivity
      typingTimeoutRef.current = setTimeout(() => {
        sendTyping(chatId, false)
      }, 2000)
    }
  }

  const handleSend = async () => {
    if (!input.trim() || sending) return
    setSending(true)
    setSendError(null)
    
    // Stop typing indicator
    if (connected) {
      sendTyping(chatId, false)
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current)
      }
    }
    
    try {
      await sendChatMessage({ data: { chatId, content: input.trim() } })
      setInput('')
      // Always invalidate. Gating this on `connected` assumed the socket would
      // deliver the echo, which is not something the client can verify.
      qc.invalidateQueries({ queryKey: ['chat', chatId] })
      qc.invalidateQueries({ queryKey: ['conversations'] })
    } catch (e: any) {
      setSendError(e?.message || 'Failed to send message.')
    } finally {
      setSending(false)
    }
  }

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg'
      const recorder = new MediaRecorder(stream, { mimeType })
      const chunks: BlobPart[] = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data)
      }

      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType })
        const url = URL.createObjectURL(blob)
        setAudioBlob(blob)
        setPreviewUrl(url)
        setIsRecording(false)
        // Stop all tracks to release microphone
        stream.getTracks().forEach((t) => t.stop())
      }

      recorder.start()
      mediaRecorderRef.current = recorder
      setIsRecording(true)
      setRecordingDuration(0)
      setAudioBlob(null)
      setPreviewUrl(null)

      // Auto-stop after 60 seconds
      setTimeout(() => {
        if (recorder.state === 'recording') {
          recorder.stop()
        }
      }, 60000)
    } catch (e) {
      console.error('Failed to start recording', e)
      setSendError('Microphone access denied or unavailable')
    }
  }

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop()
    }
  }

  const cancelRecording = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setAudioBlob(null)
    setPreviewUrl(null)
    setRecordingDuration(0)
    setIsRecording(false)
    setSendError(null)
  }

  const handleSendVoice = async () => {
    if (!audioBlob || !matchId) return
    setSending(true)
    setSendError(null)

    try {
      const reader = new FileReader()
      const base64Promise = new Promise<string>((resolve) => {
        reader.onloadend = () => resolve(reader.result as string)
        reader.readAsDataURL(audioBlob)
      })
      const base64Audio = await base64Promise

      const { audioUrl } = await uploadVoiceMessage({ data: { base64Audio, matchId } })
      await sendChatMessage({
        data: { chatId, content: 'Voice message', type: 'voice', audioUrl },
      })

      cancelRecording()
      qc.invalidateQueries({ queryKey: ['chat', chatId] })
      qc.invalidateQueries({ queryKey: ['conversations'] })
    } catch (e: any) {
      setSendError(e?.message || 'Failed to send voice message.')
    } finally {
      setSending(false)
    }
  }

  const photo = peerProfile?.photos?.[0]

  if (error) {
    return (
      <div className="page-wrap flex h-[calc(100dvh-112px)] flex-col items-center justify-center px-4 py-4 text-center">
        <p className="text-sm text-[var(--mag-sale)]">{(error as any)?.message || 'Unable to open chat.'}</p>
        <button
          onClick={() => navigate({ to: '/chats' })}
          className="mt-4 inline-flex items-center gap-2 rounded-full bg-[var(--mag-ink)] px-6 py-3 font-medium text-[var(--mag-bg)] transition active:scale-95 hover:opacity-80"
        >
          <ArrowLeft className="h-4 w-4" /> Go back
        </button>
      </div>
    )
  }

  return (
    <div className="page-wrap flex h-[calc(100dvh-112px)] flex-col px-4 py-4">
      {/* Header */}
      <div className="mb-3 flex items-center gap-2 border-b border-[var(--mag-line)] pb-3">
        <button onClick={() => history.back()} className="rounded-full p-2 text-[var(--mag-ink-soft)] transition hover:bg-[var(--mag-surface)]">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex flex-1 items-center justify-center gap-2">
          <div className={`h-8 w-8 shrink-0 overflow-hidden rounded-full bg-[var(--mag-line)] ${isPhotosLocked ? 'blur-[20px] grayscale-[0.5]' : ''}`}>
            <AvatarImage src={photo} alt={peerProfile?.name ?? ''} />
          </div>
          <div className="min-w-0 text-center">
            <p className="truncate text-sm font-semibold text-[var(--mag-ink)] flex items-center justify-center gap-1.5">
              {peerProfile?.name ?? 'User'}
              {peerProfile?.verifiedAt && <VerifiedBadge />}
            </p>
            <p className="text-[10px] text-[var(--mag-ink-muted)]">
              {connected ? (
                <span className="flex items-center justify-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--mag-success)]"></span>
                  Online
                </span>
              ) : (
                peerProfile?.location
              )}
            </p>
          </div>
        </div>
        <button
          onClick={() => setBlockDialogOpen(true)}
          className="rounded-full p-2 text-[var(--mag-ink-soft)] transition hover:bg-[var(--mag-surface)]"
          title="Block user"
        >
          <Ban className="h-5 w-5" />
        </button>
      </div>

      {/* Unlock progress */}
      {isPhotosLocked && remainingMessages > 0 && (
        <div className="mb-2 rounded-xl border border-[var(--mag-line)] bg-[var(--mag-surface)] px-3 py-2 text-center text-xs font-medium text-[var(--mag-ink)]">
          Send {remainingMessages} more message{remainingMessages !== 1 ? 's' : ''} to reveal their photo 🔒
        </div>
      )}
      {isPhotosLocked && remainingMessages === 0 && (
        <div className="mb-2 rounded-xl border border-[var(--mag-line)] bg-[var(--mag-surface)] px-3 py-2 text-center text-xs font-medium text-[var(--mag-ink)]">
          Almost there! Send one more message to reveal 🔒
        </div>
      )}
      {showRevealToast && (
        <div className="mb-2 rounded-xl bg-[var(--mag-ink)] px-3 py-2 text-center text-xs font-bold text-[var(--mag-bg)] transition-all duration-500">
          Photos revealed!
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 space-y-3 overflow-y-auto pr-1">
        {isLoading ? (
          <div className="flex h-full flex-col justify-end space-y-3 pb-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className={`flex ${i % 2 === 0 ? 'justify-end' : 'justify-start'}`}>
                <Skeleton className={`h-10 rounded-2xl px-4 py-2.5 ${i % 2 === 0 ? 'w-32 rounded-br-md' : 'w-40 rounded-bl-md'}`} />
              </div>
            ))}
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--mag-ink-muted)]">Start the conversation!</div>
        ) : (
          <>
            {hasOlder && (
              <div className="mb-2 flex justify-center">
                <button
                  onClick={loadOlder}
                  disabled={loadingOlder}
                  className="rounded-full border border-[var(--mag-line)] bg-[var(--mag-card)] px-4 py-1.5 text-xs font-medium text-[var(--mag-ink-soft)] transition hover:bg-[var(--mag-surface)] disabled:opacity-50"
                >
                  {loadingOlder ? 'Loading…' : 'Load earlier messages'}
                </button>
              </div>
            )}
            {messages.map((msg: any) => (
              <div key={msg.id} className={`flex ${msg.isMine ? 'justify-end' : 'justify-start'}`}>
                {msg.type === 'voice' && msg.audioUrl ? (
                  <div className="max-w-[75%]">
                    <VoiceMessagePlayer url={msg.audioUrl} isMine={msg.isMine} />
                    <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-[var(--mag-ink-muted)]">
                      <span suppressHydrationWarning>{new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      {msg.isMine && (
                        msg.readAt ? (
                          <CheckCheck className="h-3 w-3" />
                        ) : (
                          <Check className="h-3 w-3" />
                        )
                      )}
                    </div>
                  </div>
                ) : (
                  <div className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm ${msg.isMine ? 'rounded-br-md bg-[var(--mag-ink)] text-[var(--mag-bg)]' : 'rounded-bl-md border border-[var(--mag-line)] bg-[var(--mag-surface)] text-[var(--mag-ink)]'}`}>
                    {msg.content}
                    <div className={`mt-1 flex items-center justify-end gap-1 text-[10px] ${msg.isMine ? 'text-white/70' : 'text-[var(--mag-ink-muted)]'}`}>
                      <span suppressHydrationWarning>{new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      {msg.isMine && (
                        msg.readAt ? (
                          <CheckCheck className="h-3 w-3" />
                        ) : (
                          <Check className="h-3 w-3" />
                        )
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </>
        )}
        
        {/* Typing indicator */}
        {typingUsers.length > 0 && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-md bg-[var(--mag-surface)] px-4 py-2.5">
              <div className="flex gap-1">
                <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--mag-ink-muted)]" style={{ animationDelay: '0ms' }}></span>
                <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--mag-ink-muted)]" style={{ animationDelay: '150ms' }}></span>
                <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--mag-ink-muted)]" style={{ animationDelay: '300ms' }}></span>
              </div>
            </div>
          </div>
        )}
      </div>

      {matchId && icebreakers && icebreakers.length > 0 && (chatData?.messages.length ?? 0) < 3 && (
        <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
          {icebreakers.map((ice) => (
            <button
              key={ice.id}
              onClick={() => setInput(ice.text)}
              className="shrink-0 rounded-full border border-[var(--mag-line)] bg-[var(--mag-bg)] px-3 py-1.5 text-xs font-medium text-[var(--mag-ink)] transition hover:bg-[var(--mag-surface)]"
            >
              {ice.text}
            </button>
          ))}
        </div>
      )}
      {sendError && <p className="mb-1 text-xs text-[var(--mag-sale)]">{sendError}</p>}
      <div className="mt-3 flex items-center gap-2">
        {isRecording ? (
          <>
            <div className="flex flex-1 items-center gap-2 rounded-full border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-600">
              <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--mag-sale)]" />
              <span>Recording {formatDuration(recordingDuration)}</span>
            </div>
            <button
              onClick={stopRecording}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--mag-surface)] text-[var(--mag-sale)]"
              aria-label="Stop recording"
            >
              <Square className="h-4 w-4 animate-pulse" />
            </button>
            <button disabled className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--mag-ink)] text-[var(--mag-bg)] opacity-60">
              <Send className="h-4 w-4" />
            </button>
          </>
        ) : previewUrl ? (
          <>
            <div className="flex flex-1 items-center gap-2 rounded-full border border-[var(--mag-line)] bg-[var(--input-bg)] px-4 py-2 text-sm">
              <button
                onClick={() => {
                  const audio = new Audio(previewUrl)
                  audio.play()
                }}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--mag-line)]"
                aria-label="Play voice preview"
              >
                <Play className="h-4 w-4" />
              </button>
              <span className="text-[var(--mag-ink)]">Voice message</span>
            </div>
            <button
              onClick={cancelRecording}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--mag-surface)] text-[var(--mag-ink-muted)]"
              aria-label="Cancel voice message"
            >
              <X className="h-5 w-5" />
            </button>
            <button
              onClick={handleSendVoice}
              disabled={sending}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--mag-ink)] text-[var(--mag-bg)] transition hover:opacity-80 disabled:opacity-60"
            >
              <Send className="h-4 w-4" />
            </button>
          </>
        ) : (
          <>
            <input type="text" value={input} onChange={(e) => handleInputChange(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              placeholder="Type a message..."
              disabled={sending}
              className="flex-1 rounded-full border border-[var(--mag-line)] bg-[var(--input-bg)] px-4 py-2 text-sm text-[var(--mag-ink)] focus:border-[var(--mag-ink-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--mag-line)] disabled:opacity-60" />
            {matchId && (
              <button
                onClick={startRecording}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--mag-surface)] text-[var(--mag-ink-muted)]"
                aria-label="Record voice message"
              >
                <Mic className="h-5 w-5" />
              </button>
            )}
            <button onClick={handleSend} disabled={sending} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--mag-ink)] text-[var(--mag-bg)] transition hover:opacity-80 disabled:opacity-60">
              <Send className="h-4 w-4" />
            </button>
          </>
        )}
      </div>

      {/* Block Confirmation Dialog */}
      {blockDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-5">
            <div className="mb-1 flex items-center gap-2 text-[var(--mag-sale)]">
              <Ban className="h-5 w-5" />
              <h3 className="text-sm font-semibold">Block {peerProfile?.name ?? 'User'}</h3>
            </div>
            <p className="mb-4 text-sm text-[var(--mag-ink-soft)]">
              Block {peerProfile?.name ?? 'this user'}? They won't see you in events anymore.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setBlockDialogOpen(false)}
                className="flex-1 rounded-full border border-[var(--mag-line)] bg-[var(--mag-bg)] px-6 py-3 font-medium text-[var(--mag-ink)] transition hover:bg-[var(--mag-surface)]"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (peerId) blockMutation.mutate({ data: peerId })
                }}
                disabled={blockMutation.isPending || !peerId}
                className="flex-1 rounded-full bg-[var(--mag-sale)] px-6 py-3 font-medium text-[var(--mag-bg)] transition hover:opacity-80 disabled:opacity-50"
              >
                {blockMutation.isPending ? 'Blocking…' : 'Block'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
