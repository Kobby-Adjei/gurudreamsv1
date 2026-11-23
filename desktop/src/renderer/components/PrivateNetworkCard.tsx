import { useId } from 'react'
import { NET_COPY, netPhase, type NetworkState } from '../lib/network'
import { Button } from './Button'
import { Card, CardHeader } from './Card'
import { RefreshIcon } from './Icons'
import { StatusDot, type DotStatus } from './StatusDot'

/**
 * Settings card for the private network AirBridge runs for you. Plain words
 * only; the address and any technical detail sit behind "Details".
 */
export function PrivateNetworkCard({ network }: { network: NetworkState }) {
  const headingId = useId()
  const phase = netPhase(network.status)
  const copy = NET_COPY[phase]
  const ip = network.status?.ip
  const detail = network.status?.detail
  const hasDetails = !!ip || (phase !== 'connected' && !!detail)

  return (
    <Card as="section" aria-labelledby={headingId}>
      <CardHeader
        id={headingId}
        title="Private network"
        description="Links your computers directly. Devices running AirBridge and signed in to the same account appear automatically."
      />
      <dl className="divide-y divide-line/[0.06] border-y border-line/[0.06]">
        <div className="flex min-h-[48px] items-center justify-between gap-4 py-2">
          <dt className="text-[13px] text-ink-muted">Status</dt>
          <dd className="flex items-center gap-3">
            <StatusDot status={copy.dot} label={copy.label} />
          </dd>
        </div>
      </dl>
      {phase === 'error' || phase === 'off' ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="secondary" icon={<RefreshIcon size={15} />} loading={network.retrying} onClick={() => void network.retry()}>
            Retry
          </Button>
          <span className="text-[13px] text-ink-muted">Check that this computer is online.</span>
        </div>
      ) : null}
      {hasDetails ? (
        <details className="group mt-4 text-[13px]">
          <summary className="w-fit cursor-pointer select-none rounded-md text-ink-muted hover:text-ink">
            Details
          </summary>
          <dl className="mt-2 space-y-1.5 text-ink-muted">
            {ip ? (
              <div className="flex justify-between gap-4">
                <dt>Address</dt>
                <dd className="font-mono text-[12.5px] text-ink selectable">{ip}</dd>
              </div>
            ) : null}
            {detail && phase !== 'connected' ? (
              <div className="flex justify-between gap-4">
                <dt>Message</dt>
                <dd className="min-w-0 text-right text-ink selectable [overflow-wrap:anywhere]">{detail}</dd>
              </div>
            ) : null}
          </dl>
        </details>
      ) : null}
    </Card>
  )
}

/**
 * Preview on the computer's existing network (PHASE3_PLAN.md §8): nothing of
 * ours to manage, so this only says whether it's working and, if not, the one
 * thing to check.
 */
export function ExistingNetworkCard({
  network,
  devicesProblem,
  hint
}: {
  network: NetworkState
  devicesProblem: boolean
  hint: string
}) {
  const headingId = useId()
  const phase = netPhase(network.status)
  const problem = phase === 'error' || devicesProblem
  const copy = problem ? { dot: 'error' as const, label: 'Can’t see other devices' } : NET_COPY[phase]
  return (
    <Card as="section" aria-labelledby={headingId}>
      <CardHeader
        id={headingId}
        title="Private network"
        description="During the preview, AirBridge connects through the network already set up on this computer."
      />
      <dl className="divide-y divide-line/[0.06] border-y border-line/[0.06]">
        <div className="flex min-h-[48px] items-center justify-between gap-4 py-2">
          <dt className="text-[13px] text-ink-muted">Status</dt>
          <dd className="flex items-center gap-3">
            <StatusDot status={copy.dot} label={copy.label} />
          </dd>
        </div>
      </dl>
      {problem ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="secondary" icon={<RefreshIcon size={15} />} loading={network.retrying} onClick={() => void network.retry()}>
            Retry
          </Button>
          <span className="text-[13px] font-medium text-ink">{hint}</span>
        </div>
      ) : null}
    </Card>
  )
}

// Same palette as StatusDot; here only the state word is tinted so the line stays quiet.
const DOT_BG: Record<DotStatus, string> = {
  online: 'bg-ok-dot',
  offline: 'bg-ink-faint/70',
  warning: 'bg-warn',
  error: 'bg-danger',
  starting: 'bg-ink-muted'
}
const DOT_TEXT: Record<DotStatus, string> = {
  online: 'text-ok',
  offline: 'text-ink-faint',
  warning: 'text-warn',
  error: 'text-danger',
  starting: 'text-ink-muted'
}

/** One quiet line for the sidebar footer: "Private network · Connected". */
export function PrivateNetworkStatusLine({ network }: { network: NetworkState }) {
  const phase = netPhase(network.status)
  const copy = NET_COPY[phase]
  return (
    <div className="flex min-w-0 items-center justify-between gap-2" data-testid="network-line">
      <span className="flex min-w-0 items-center gap-1.5 truncate text-[12px] font-medium" data-status={copy.dot}>
        <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${DOT_BG[copy.dot]}`} />
        <span className="truncate text-ink-muted">
          Private network · <span className={DOT_TEXT[copy.dot]}>{copy.label}</span>
        </span>
      </span>
      {phase === 'error' || phase === 'off' ? (
        <button
          type="button"
          onClick={() => void network.retry()}
          disabled={network.retrying}
          className="app-no-drag shrink-0 rounded-md text-[12px] font-medium text-ink underline underline-offset-2 hover:text-ink-muted disabled:opacity-60"
        >
          Retry
        </button>
      ) : null}
    </div>
  )
}
