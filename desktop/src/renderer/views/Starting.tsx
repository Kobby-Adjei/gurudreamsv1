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
        <div className="mb-6 text-ink">
          <LogoMark size={40} />
        </div>
        <h1 className="text-[22px] font-semibold tracking-tightish text-ink">{title}</h1>
        <p className="mt-2 max-w-[340px] text-[14px] leading-6 text-ink-muted">{body}</p>
        <div className="mt-7 text-ink-faint">
          <Spinner size={22} />
        </div>
      </div>
    </OnboardingFrame>
  )
}
