import { CheckIcon, LogoMark } from '../components/Icons'
import { Spinner } from '../components/Spinner'
import { OnboardingFrame } from './OnboardingFrame'

export type StepState = 'done' | 'active' | 'pending'

export interface StartStep {
  label: string
  state: StepState
}

export function Starting({
  title = 'Starting AirBridge',
  body = 'This usually takes a few seconds.',
  steps
}: {
  title?: string
  body?: string
  /** Quiet checklist under the title; without it a single spinner is shown. */
  steps?: StartStep[]
}) {
  return (
    <OnboardingFrame>
      <div role="status" aria-live="polite" className="flex flex-col items-center text-center">
        <div className="mb-6 text-ink">
          <LogoMark size={40} />
        </div>
        <h1 className="text-[22px] font-semibold tracking-tightish text-ink">{title}</h1>
        <p className="mt-2 max-w-[340px] text-[14px] leading-6 text-ink-muted">{body}</p>
        {steps?.length ? (
          <ol aria-label="Progress" className="mt-8 w-full max-w-[300px] space-y-3 text-left">
            {steps.map((s) => (
              <li key={s.label} className="flex items-center gap-3" data-step={s.state}>
                <span className="grid h-5 w-5 shrink-0 place-items-center" aria-hidden="true">
                  {s.state === 'done' ? (
                    <CheckIcon size={16} className="text-ink-muted" />
                  ) : s.state === 'active' ? (
                    <Spinner size={15} className="text-ink-muted" />
                  ) : (
                    <span className="h-1.5 w-1.5 rounded-full bg-ink-faint/60" />
                  )}
                </span>
                <span className={`text-[14px] ${s.state === 'pending' ? 'text-ink-faint' : s.state === 'done' ? 'text-ink-muted' : 'text-ink'}`}>
                  {s.label}
                  <span className="sr-only">{s.state === 'done' ? ' — done' : s.state === 'active' ? ' — in progress' : ' — waiting'}</span>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <div className="mt-7 text-ink-faint">
            <Spinner size={22} />
          </div>
        )}
      </div>
    </OnboardingFrame>
  )
}
