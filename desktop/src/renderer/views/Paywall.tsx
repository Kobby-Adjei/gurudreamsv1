import { useState } from 'react'
import type { AuthUser } from '../../shared/types'
import { Button } from '../components/Button'
import { CheckIcon, LogoMark } from '../components/Icons'
import { api, errorText } from '../lib/api'
import { OnboardingFrame } from './OnboardingFrame'

const BENEFITS = [
  'Connect all your computers',
  'Send tasks and code between Claude, Cursor and Codex',
  'Live map of which computers are online',
  'Activity feed of everything sent and received',
  'Private: tasks go straight between your own computers'
]

export function Paywall({ user, onRecheck }: { user?: AuthUser; onRecheck: () => Promise<boolean> }) {
  const [busy, setBusy] = useState<'checkout' | 'check' | 'signout' | null>(null)
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

  async function signOut() {
    setBusy('signout')
    try {
      await api().auth.signOut()
    } finally {
      setBusy(null)
    }
  }

  return (
    <OnboardingFrame>
      <div className="rounded-2xl border border-line/[0.08] bg-surface-1 p-8">
        <div className="flex items-center gap-3">
          <span className="text-ink">
            <LogoMark size={28} />
          </span>
          <div>
            <h1 className="text-[20px] font-semibold tracking-tightish text-ink">AirBridge Pro</h1>
            <p className="text-[13px] text-ink-muted">One subscription, all your computers</p>
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
          <Button
            variant="primary"
            size="lg"
            block
            loading={busy === 'checkout'}
            onClick={subscribe}
          >
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

      <p className="mt-6 text-center text-[13px] text-ink-faint">
        Signed in as <span className="text-ink-muted">{user?.email ?? 'you'}</span> ·{' '}
        <button
          type="button"
          onClick={signOut}
          disabled={busy === 'signout'}
          className="font-medium text-ink-muted underline underline-offset-2 hover:text-ink"
        >
          Use a different account
        </button>
      </p>
    </OnboardingFrame>
  )
}
