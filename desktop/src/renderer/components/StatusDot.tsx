export type DotStatus = 'online' | 'offline' | 'warning' | 'error' | 'starting'

const dotColor: Record<DotStatus, string> = {
  online: 'bg-ok-dot',
  offline: 'bg-ink-faint/70',
  warning: 'bg-warn',
  error: 'bg-danger',
  starting: 'bg-ink-muted'
}

const textColor: Record<DotStatus, string> = {
  online: 'text-ok',
  offline: 'text-ink-faint',
  warning: 'text-warn',
  error: 'text-danger',
  starting: 'text-ink-muted'
}

const defaultLabel: Record<DotStatus, string> = {
  online: 'Online',
  offline: 'Offline',
  warning: 'Needs attention',
  error: 'Problem',
  starting: 'Starting'
}

/**
 * A small solid dot plus text. Status is never colour-only: the label is
 * always present (visible by default, or screen-reader-only with `hideLabel`).
 */
export function StatusDot({
  status,
  label,
  hideLabel = false,
  className = ''
}: {
  status: DotStatus
  label?: string
  hideLabel?: boolean
  className?: string
}) {
  const text = label ?? defaultLabel[status]
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${textColor[status]} ${className}`}
      data-status={status}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dotColor[status]}`}
        data-testid={`status-dot-${status}`}
      />
      <span className={hideLabel ? 'sr-only' : ''}>{text}</span>
    </span>
  )
}
