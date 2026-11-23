import { Button } from '../components/Button'
import { LogoMark } from '../components/Icons'
import { OnboardingFrame } from './OnboardingFrame'

const POINTS: { title: string; body: string }[] = [
  {
    title: 'Your computers, working together',
    body: 'Ask Claude on your laptop to have your desktop run the tests.'
  },
  {
    title: 'Private by design',
    body: 'Tasks travel straight between your own computers over Tailscale.'
  },
  {
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
        <div className="mb-6 text-ink">
          <LogoMark size={40} />
        </div>
        <h1 className="text-[28px] font-semibold leading-[34px] tracking-display text-ink">Welcome to AirBridge</h1>
        <p className="mt-3 max-w-[380px] text-[15px] leading-6 text-ink-muted">
          Let the AI apps on your computers — Claude, Cursor, Codex — pass work to each other.
        </p>
      </div>

      <ul className="mt-9 divide-y divide-line/[0.08] border-y border-line/[0.08]">
        {POINTS.map((p) => (
          <li key={p.title} className="py-3.5">
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
              <button type="button" onClick={onSignIn} className="font-medium text-ink underline underline-offset-2">
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
