import { LogoMark } from '../components/Icons'
import { Spinner } from '../components/Spinner'
import { OnboardingFrame } from './OnboardingFrame'

export function Starting({
  title = 'Starting AirBridge',
  body = 'Connecting to your other computers. This usually takes a few seconds.'
}: {
  title?: string
  body?: string
}) {
  return (
    <OnboardingFrame>
      <div role="status" aria-live="polite" className="flex flex-col items-center text-center">
        <div className="relative mb-8">
          <span aria-hidden="true" className="absolute -inset-6 rounded-full bg-accent/25 blur-2xl animate-breathe" />
          <span aria-hidden="true" className="absolute -inset-3 rounded-[26px] border border-accent/30 animate-pulse-ring" />
          <div className="relative">
            <LogoMark size={72} />
          </div>
        </div>
        <h1 className="text-[22px] font-semibold tracking-tightish text-ink">{title}</h1>
        <p className="mt-2 max-w-[340px] text-[14px] leading-6 text-ink-muted">{body}</p>
        <div className="mt-7 text-accent-ink">
          <Spinner size={22} />
        </div>
      </div>
    </OnboardingFrame>
  )
}
