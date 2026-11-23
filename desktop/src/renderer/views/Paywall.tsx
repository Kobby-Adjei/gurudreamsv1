import { useEffect, useState } from 'react'
import type { AuthUser } from '../../shared/types'
import { Button } from '../components/Button'
import { ArrowLeftIcon, CheckIcon, LogoMark } from '../components/Icons'
import { api, errorText } from '../lib/api'
import { OnboardingFrame } from './OnboardingFrame'

const BENEFITS = [
  'Connect all your computers',
  'Send tasks and code between Claude, Cursor and Codex',
  'Live map of which computers are online',
  'Activity feed of everything sent and received',
  'Private: tasks go straight between your own computers'
]

/**
 * Price, what's included, Subscribe and "check again". Shared by the blocking
 * Paywall (enforced) and the non-blocking Plans page (preview).
 */
export function PlansCard({ onRecheck, tagline = 'One subscription, all your computers' }: { onRecheck: () => Promise<boolean>; tagline?: string }) {
  const [busy, setBusy] = useState<'checkout' | 'check' | null>(null)
  const [note, setNote] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)

  async function subscribe() {
    setBusy('checkout')
    setNote(null)
    try {
      await api().license.openCheckout()
      setNote({ tone: 'info', text: 'We opened checkout in your browser. Come back here when you’re done.' })
    } catch (err) {
      setNote({ tone: 'error', text: errorText(err) })
    } finally {
      setBusy(null)
    }
  }

  async function check() {
    setBusy('check')
    setNote(null)
    try {
      const ok = await onRecheck()
      if (!ok)
        setNote({
          tone: 'info',
          text: 'We couldn’t find an active subscription yet. It can take a minute after paying — try again shortly.'
        })
    } catch (err) {
      setNote({ tone: 'error', text: errorText(err) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="rounded-2xl border border-line/[0.08] bg-surface-1 p-8">
      <div className="flex items-center gap-3">
        <span className="text-ink">
          <LogoMark size={28} />
        </span>
        <div>
          <h1 tabIndex={-1} className="text-[20px] font-semibold tracking-tightish text-ink outline-none">
            AirBridge Pro
          </h1>
          <p className="text-[13px] text-ink-muted">{tagline}</p>
        </div>
      </div>

      <p className="mt-7 flex items-baseline gap-1.5">
        <span className="text-[44px] font-semibold leading-none tracking-display text-ink">$15</span>
        <span className="text-[15px] text-ink-muted">/ month</span>
      </p>
      <p className="mt-1.5 text-[13px] text-ink-faint">Cancel any time.</p>

      <ul className="mt-7 space-y-3" aria-label="What’s included">
        {BENEFITS.map((b) => (
          <li key={b} className="flex items-start gap-3 text-[14px] leading-5 text-ink">
            <CheckIcon size={16} strokeWidth={2} className="mt-0.5 shrink-0 text-ink-muted" />
            {b}
          </li>
        ))}
      </ul>

      <div className="mt-8 space-y-3">
        <Button variant="primary" size="lg" block loading={busy === 'checkout'} onClick={subscribe}>
          Subscribe
        </Button>
        <Button variant="secondary" size="lg" block loading={busy === 'check'} onClick={check}>
          I’ve subscribed — check again
        </Button>
      </div>

      <div className="text-center text-[13px] leading-5 empty:hidden [&:not(:empty)]:mt-4" aria-live="polite">
        {note ? (
          <span role={note.tone === 'error' ? 'alert' : undefined} className={note.tone === 'error' ? 'text-danger' : 'text-ink-muted'}>
            {note.text}
          </span>
        ) : null}
      </div>
    </div>
  )
}

/** Enforced mode: the full-window wall shown when there's no active subscription. */
export function Paywall({ user, onRecheck }: { user?: AuthUser; onRecheck: () => Promise<boolean> }) {
  const [signingOut, setSigningOut] = useState(false)

  async function signOut() {
    setSigningOut(true)
    try {
      await api().auth.signOut()
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <OnboardingFrame>
      <PlansCard onRecheck={onRecheck} />
      <p className="mt-6 text-center text-[13px] text-ink-faint">
        Signed in as <span className="text-ink-muted">{user?.email ?? 'you'}</span> ·{' '}
        <button
          type="button"
          onClick={signOut}
          disabled={signingOut}
          className="font-medium text-ink-muted underline underline-offset-2 hover:text-ink"
        >
          Use a different account
        </button>
      </p>
    </OnboardingFrame>
  )
}

/**
 * Preview mode: the same plans, reachable from Settings → Account, as an
 * ordinary page inside the app with a way back. Never blocks anything.
 */
export function PlansPage({ onBack, onRecheck }: { onBack: () => void; onRecheck: () => Promise<boolean> }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  return (
    <div className="pb-10 pt-10">
      <Button variant="ghost" size="sm" icon={<ArrowLeftIcon size={15} />} onClick={onBack} className="-ml-3">
        Back
      </Button>
      <div className="mx-auto mt-6 w-full max-w-[420px]">
        <PlansCard onRecheck={onRecheck} tagline="Everything is unlocked during the preview" />
      </div>
    </div>
  )
}
