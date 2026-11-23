export type DotStatus = 'online' | 'offline' | 'warning' | 'error' | 'starting'

const dotColor: Record<DotStatus, string> = {
  online: 'bg-ok-dot',
  offline: 'bg-ink-faint/70',
  warning: 'bg-warn',
  error: 'bg-danger',
  starting: 'bg-accent-ink'
}

const textColor: Record<DotStatus, string> = {
  online: 'text-ok',
  offline: 'text-ink-faint',
  warning: 'text-warn',
  error: 'text-danger',
  starting: 'text-accent-ink'
}

const defaultLabel: Record<DotStatus, string> = {
  online: 'Online',
  offline: 'Offline',
  warning: 'Needs attention',
  error: 'Problem',
  starting: 'Starting'
}

/**
 * Status is never colour-only: the dot always comes with a text label
 * (visible by default, or screen-reader-only with `hideLabel`).
 */
export function StatusDot({
  status,
  label,
  hideLabel = false,
  pulse,
  className = ''
}: {
  status: DotStatus
  label?: string
  hideLabel?: boolean
  pulse?: boolean
  className?: string
}) {
  const text = label ?? defaultLabel[status]
  const shouldPulse = pulse ?? (status === 'online' || status === 'starting')
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${textColor[status]} ${className}`}
      data-status={status}
    >
      <span className="relative inline-flex h-2 w-2 shrink-0" aria-hidden="true">
        {shouldPulse ? (
          <span className={`absolute inset-0 rounded-full ${dotColor[status]} animate-pulse-ring`} />
        ) : null}
        <span
          className={`relative inline-flex h-2 w-2 rounded-full ${dotColor[status]} ${status === 'online' ? 'shadow-[0_0_8px_rgb(var(--ok-dot)/0.7)]' : ''}`}
          data-testid={`status-dot-${status}`}
        />
      </span>
      <span className={hideLabel ? 'sr-only' : ''}>{text}</span>
    </span>
  )
}
