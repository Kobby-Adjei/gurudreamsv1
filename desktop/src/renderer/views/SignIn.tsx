import type { ReactNode } from 'react'
import { Button } from '../components/Button'
import { ArrowRightIcon, LogoMark, ShieldIcon, SparkIcon, SwarmIcon } from '../components/Icons'
import { OnboardingFrame } from './OnboardingFrame'

const POINTS: { icon: ReactNode; title: string; body: string }[] = [
  {
    icon: <SwarmIcon size={18} />,
    title: 'Your computers, working as one',
    body: 'Ask Claude on your laptop to have your desktop run the tests.'
  },
  {
    icon: <ShieldIcon size={18} />,
    title: 'Private by design',
    body: 'Tasks travel straight between your own computers over Tailscale.'
  },
  {
    icon: <SparkIcon size={18} />,
    title: 'Ready in two minutes',
    body: 'Sign in, copy one snippet into your AI app, and you’re done.'
  }
]

export function SignIn({
  signingIn,
  busy,
  error,
  onSignIn
}: {
  signingIn: boolean
  busy: boolean
  error?: string | null
  onSignIn: () => void
}) {
  return (
    <OnboardingFrame>
      <div className="flex flex-col items-center text-center">
        <div className="relative mb-7">
          <span aria-hidden="true" className="absolute -inset-4 rounded-[28px] bg-accent/25 blur-2xl animate-breathe" />
          <div className="relative">
            <LogoMark size={64} />
          </div>
        </div>
        <h1 className="text-[32px] font-semibold leading-[38px] tracking-display text-ink">Welcome to AirBridge</h1>
        <p className="mt-3 max-w-[380px] text-[15px] leading-6 text-ink-muted">
          Let the AI apps on your computers — Claude, Cursor, Codex — pass work to each other.
        </p>
      </div>

      <ul className="mt-9 space-y-2.5">
        {POINTS.map((p) => (
          <li
            key={p.title}
            className="flex items-start gap-3.5 rounded-2xl border border-line/[0.06] bg-surface-1/70 px-4 py-3.5 shadow-inset-line backdrop-blur"
          >
            <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-accent/15 text-accent-ink">
              {p.icon}
            </span>
            <span>
              <span className="block text-[14px] font-semibold text-ink">{p.title}</span>
              <span className="mt-0.5 block text-[13px] leading-5 text-ink-muted">{p.body}</span>
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-8">
        <Button
          variant="primary"
          size="lg"
          block
          loading={signingIn || busy}
          trailingIcon={signingIn || busy ? undefined : <ArrowRightIcon size={18} />}
          onClick={onSignIn}
        >
          {signingIn ? 'Waiting for your browser…' : 'Sign in to continue'}
        </Button>
        <div className="mt-4 min-h-[20px] text-center text-[13px] text-ink-faint" aria-live="polite">
          {error ? (
            <span role="alert" className="text-danger">
              {error}
            </span>
          ) : signingIn ? (
            <>
              Finish signing in in the browser window we opened.{' '}
              <button type="button" onClick={onSignIn} className="font-medium text-accent-ink underline-offset-2 hover:underline">
                Didn’t open? Try again
              </button>
            </>
          ) : (
            'We’ll open your browser to sign in securely.'
          )}
        </div>
      </div>
    </OnboardingFrame>
  )
}
