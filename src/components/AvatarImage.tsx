import { User } from 'lucide-react'

interface AvatarImageProps {
  src?: string | null
  alt?: string
  className?: string
  imgClassName?: string
  /**
   * Set on the one image that's on screen at load (the top card, the chat
   * header) so it isn't deferred behind lazy loading.
   */
  priority?: boolean
}

export default function AvatarImage({
  src,
  alt = '',
  className = '',
  imgClassName = '',
  priority = false,
}: AvatarImageProps) {
  const hasImage = Boolean(src && src.trim())

  if (hasImage) {
    return (
      <img
        src={src!}
        alt={alt}
        // Photos are full-bleed profile images from R2. Without lazy loading,
        // every card in a rendered deck fetched its image immediately.
        loading={priority ? 'eager' : 'lazy'}
        decoding="async"
        fetchPriority={priority ? 'high' : 'auto'}
        draggable={false}
        className={`h-full w-full object-cover ${imgClassName}`.trim()}
      />
    )
  }

  return (
    <div
      className={`flex h-full w-full items-center justify-center bg-[var(--mag-surface)] text-[var(--mag-ink-muted)] ${className}`.trim()}
    >
      <User className="h-[60%] w-[60%]" strokeWidth={1.5} />
    </div>
  )
}
