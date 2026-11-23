import { useId } from 'react'
import { NET_COPY, netPhase, type NetworkState } from '../lib/network'
import { useSignIn } from '../lib/signIn'
import { Button } from './Button'
import { Card, CardHeader } from './Card'
import { RefreshIcon } from './Icons'
import { SIGN_IN_BODY } from './SignInPrompt'
import { StatusDot, type DotStatus } from './StatusDot'

/**
 * Settings card for the private network AirBridge runs for you. Plain words
 * only; the address and any technical detail sit behind "Details".
 *
 * `signIn` (preview, signed out): the network waits for a sign-in, so the card
 * says so and offers it, instead of a status that would never change.
 */
export function PrivateNetworkCard({ network, signIn }: { network: NetworkState; signIn?: { signingIn: boolean } }) {
  const headingId = useId()
  const phase = netPhase(network.status)
  const copy = signIn ? SIGN_IN_STATUS : NET_COPY[phase]
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
      {signIn ? (
        <CardSignIn signingIn={signIn.signingIn} />
      ) : phase === 'error' || phase === 'off' ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="secondary" icon={<RefreshIcon size={15} />} loading={network.retrying} onClick={() => void network.retry()}>
            Retry
          </Button>
          <span className="text-[13px] text-ink-muted">Check that this computer is online.</span>
        </div>
      ) : null}
      {hasDetails && !signIn ? (
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

const SIGN_IN_STATUS: { dot: DotStatus; label: string } = { dot: 'offline', label: 'Sign in to connect' }

function CardSignIn({ signingIn }: { signingIn: boolean }) {
  const { busy, signIn } = useSignIn()
  return (
    <div className="mt-4 space-y-3">
      <p className="text-[13px] leading-5 text-ink-muted">{SIGN_IN_BODY}</p>
      {signingIn ? (
        <p role="status" className="text-[13px] text-ink-muted">
          Finish signing in in your browser…
        </p>
      ) : (
        <Button variant="primary" size="sm" loading={busy} onClick={() => void signIn()}>
          Sign in
        </Button>
      )}
    </div>
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

/**
 * One quiet line for the sidebar footer: "Private network · Connected".
 * Preview, signed out: "Private network · Sign in to connect", with a text "Sign in".
 */
export function PrivateNetworkStatusLine({ network, signIn }: { network: NetworkState; signIn?: { signingIn: boolean } }) {
  const phase = netPhase(network.status)
  const copy = signIn ? SIGN_IN_STATUS : NET_COPY[phase]
  return (
    // Signed out the words are longer: the state wraps to a second line (never cut short),
    // with "Sign in" beside it.
    <div
      className={`flex min-w-0 justify-between gap-2 ${signIn ? 'items-end' : 'items-center'}`}
      data-testid="network-line"
    >
      <span
        className={`flex min-w-0 gap-1.5 text-[12px] font-medium ${signIn ? 'items-baseline leading-[18px]' : 'items-center truncate'}`}
        data-status={copy.dot}
      >
        <span
          aria-hidden="true"
          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${DOT_BG[copy.dot]} ${signIn ? 'relative -top-px' : ''}`}
        />
        <span className={signIn ? 'text-ink-muted' : 'truncate text-ink-muted'}>
          Private network · <span className={`${DOT_TEXT[copy.dot]} ${signIn ? 'whitespace-nowrap' : ''}`}>{copy.label}</span>
        </span>
      </span>
      {signIn ? (
        signIn.signingIn ? null : <LineSignIn />
      ) : phase === 'error' || phase === 'off' ? (
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

function LineSignIn() {
  const { busy, signIn } = useSignIn()
  return (
    <button
      type="button"
      onClick={() => void signIn()}
      disabled={busy}
      className="app-no-drag shrink-0 rounded-md text-[12px] font-medium text-ink underline underline-offset-2 hover:text-ink-muted disabled:opacity-60"
    >
      Sign in
    </button>
  )
}
