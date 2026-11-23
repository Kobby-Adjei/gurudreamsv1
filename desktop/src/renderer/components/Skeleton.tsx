/** Shimmering placeholder block. Decorative – announce loading elsewhere. */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`relative block overflow-hidden rounded-lg bg-line/[0.06] ${className}`}
    >
      <span className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-line/[0.06] to-transparent" />
    </span>
  )
}

export function SkeletonRows({ rows = 5, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-live="polite" className="space-y-3">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 rounded-2xl px-4 py-3">
          <Skeleton className="h-9 w-9 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-3 w-1/4" />
          </div>
        </div>
      ))}
    </div>
  )
}
