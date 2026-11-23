import type { ReactNode } from 'react'
import { Button } from '../components/Button'
import { AlertIcon, RefreshIcon } from '../components/Icons'
import { OnboardingFrame } from './OnboardingFrame'

/** Full-window problem state with exactly one clear next action; technical detail stays behind “Details”. */
export function ErrorScreen({
  icon = <AlertIcon size={28} />,
  title,
  body,
  step,
  actionLabel = 'Retry',
  onAction,
  busy = false,
  detail
}: {
  icon?: ReactNode
  title: string
  body: ReactNode
  step?: string
  actionLabel?: string
  onAction: () => void
  busy?: boolean
  detail?: string | null
}) {
  return (
    <OnboardingFrame>
      <div className="flex flex-col items-center text-center">
        <div className="mb-6 grid h-16 w-16 place-items-center rounded-[20px] bg-warn/10 text-warn ring-1 ring-inset ring-warn/25">
          {icon}
        </div>
        <h1 className="text-[22px] font-semibold tracking-tightish text-ink">{title}</h1>
        <div className="mt-2 max-w-[360px] text-[14px] leading-6 text-ink-muted">{body}</div>
        {step ? (
          <p className="mt-5 rounded-xl border border-line/[0.08] bg-surface-1 px-4 py-3 text-[14px] font-medium text-ink">
            {step}
          </p>
        ) : null}
        <div className="mt-7">
          <Button variant="primary" size="lg" icon={<RefreshIcon size={17} />} loading={busy} onClick={onAction}>
            {actionLabel}
          </Button>
        </div>
        {detail ? (
          <details className="mt-6 max-w-[360px] text-[13px]">
            <summary className="mx-auto w-fit cursor-pointer select-none rounded-md text-ink-faint hover:text-ink-muted">
              Details
            </summary>
            <p className="mt-2 font-mono text-[11.5px] text-ink-faint selectable [overflow-wrap:anywhere]">{detail}</p>
          </details>
        ) : null}
      </div>
    </OnboardingFrame>
  )
}
