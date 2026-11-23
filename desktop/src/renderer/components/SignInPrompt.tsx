import { useSignIn } from '../lib/signIn'
import { Button } from './Button'
import { Card } from './Card'
import { EmptyState } from './EmptyState'
import { LaptopIcon } from './Icons'

export const SIGN_IN_TITLE = 'Sign in to connect your devices'
export const SIGN_IN_BODY = 'Sign in once on each computer — AirBridge connects them privately. Nothing else to install.'

/**
 * Preview, signed out: the Devices page asks for the one thing the private
 * network needs. Calm and in place; the rest of the app stays usable.
 */
export function SignInPrompt({ signingIn }: { signingIn: boolean }) {
  const { busy, signIn } = useSignIn()
  return (
    <Card>
      <EmptyState
        icon={<LaptopIcon size={26} />}
        title={SIGN_IN_TITLE}
        action={
          signingIn ? (
            <p role="status" className="text-[14px] text-ink-muted">
              Finish signing in in your browser…
            </p>
          ) : (
            <Button variant="primary" loading={busy} onClick={() => void signIn()}>
              Sign in
            </Button>
          )
        }
      >
        {SIGN_IN_BODY}
      </EmptyState>
    </Card>
  )
}
