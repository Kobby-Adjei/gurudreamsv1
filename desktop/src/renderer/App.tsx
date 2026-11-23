import { useCallback, useEffect, useRef, useState } from 'react'
import type { AuthState, BackendLifecycle, LicenseStatus } from '../shared/types'
import { WifiOffIcon } from './components/Icons'
import { ToastProvider } from './components/Toast'
import { api, errorText } from './lib/api'
import { ErrorScreen } from './views/ErrorScreen'
import { MainShell } from './views/MainShell'
import { Paywall } from './views/Paywall'
import { SignIn } from './views/SignIn'
import { Starting } from './views/Starting'

/**
 * App-level state machine, derived purely from the three main-process sources
 * of truth (auth, licence gate, backend lifecycle):
 *
 *   loading ─▶ signin ─▶ checking ─▶ paywall
 *                              └───▶ starting ─▶ ready
 *                                          └───▶ tailscale | crashed
 */
export type Screen =
  | { kind: 'loading' }
  | { kind: 'signin'; signingIn: boolean }
  | { kind: 'checking' }
  | { kind: 'paywall' }
  | { kind: 'starting' }
  | { kind: 'tailscale'; detail?: string }
  | { kind: 'crashed'; detail?: string }
  | { kind: 'ready' }

const TAILSCALE_RE = /tailscale|tailnet|not logged in|needslogin/i

export function deriveScreen(
  auth: AuthState | null,
  license: LicenseStatus | null,
  lifecycle: BackendLifecycle | null
): Screen {
  if (!auth) return { kind: 'loading' }
  if (auth.state !== 'signed_in') return { kind: 'signin', signingIn: auth.state === 'signing_in' }
  if (!license || license.state === 'unknown') return { kind: 'checking' }
  if (license.state === 'inactive') return { kind: 'paywall' }
  if (!lifecycle) return { kind: 'starting' }
  switch (lifecycle.phase) {
    case 'running':
      return { kind: 'ready' }
    case 'crashed':
    case 'blocked':
      return TAILSCALE_RE.test(lifecycle.detail ?? '')
        ? { kind: 'tailscale', detail: lifecycle.detail }
        : lifecycle.phase === 'blocked'
          ? { kind: 'paywall' }
          : { kind: 'crashed', detail: lifecycle.detail }
    default:
      return { kind: 'starting' }
  }
}

const isActive = (l: LicenseStatus | null) => l?.state === 'valid' || l?.state === 'grace'

export default function App() {
  return (
    <ToastProvider>
      <AppStates />
    </ToastProvider>
  )
}

function AppStates() {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [license, setLicense] = useState<LicenseStatus | null>(null)
  const [lifecycle, setLifecycle] = useState<BackendLifecycle | null>(null)
  const [busy, setBusy] = useState(false)
  const [signInError, setSignInError] = useState<string | null>(null)
  const alive = useRef(true)

  const loadLicense = useCallback(async (refresh = false) => {
    try {
      const l = refresh ? await api().license.refresh() : await api().license.getStatus()
      if (alive.current) setLicense(l)
      return l
    } catch {
      if (alive.current) setLicense((prev) => prev ?? { state: 'unknown', plan: null, exp: null })
      return null
    }
  }, [])

  useEffect(() => {
    alive.current = true
    const a = api()
    a.auth
      .getState()
      .then((s) => alive.current && setAuth(s))
      .catch(() => alive.current && setAuth({ state: 'signed_out' }))
    void loadLicense()
    a.backend
      .getLifecycle()
      .then((l) => alive.current && setLifecycle(l))
      .catch(() => undefined)

    const offAuth = a.auth.onChange((s) => {
      setAuth(s)
      setSignInError(null)
      if (s.state === 'signed_in') void loadLicense()
    })
    // The licence gate starts/stops the backend, so a lifecycle change is our
    // cue to re-read the licence too (e.g. expired → backend stopped → paywall).
    const offLife = a.backend.onLifecycle((l) => {
      setLifecycle(l)
      void loadLicense()
    })
    return () => {
      alive.current = false
      offAuth()
      offLife()
    }
  }, [loadLicense])

  const screen = deriveScreen(auth, license, lifecycle)

  // Coming back from the browser checkout? Re-check automatically.
  useEffect(() => {
    if (screen.kind !== 'paywall') return
    const onFocus = () => void loadLicense(true)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [screen.kind, loadLicense])

  // Still "unknown" after a while (offline, no cached licence)? Keep trying quietly.
  useEffect(() => {
    if (screen.kind !== 'checking' || !auth || auth.state !== 'signed_in') return
    const id = window.setInterval(() => void loadLicense(true), 10_000)
    return () => window.clearInterval(id)
  }, [screen.kind, auth, loadLicense])

  async function signIn() {
    setBusy(true)
    setSignInError(null)
    try {
      await api().auth.signIn()
    } catch (err) {
      setSignInError(`Couldn’t start sign-in: ${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  async function retryBackend() {
    setBusy(true)
    try {
      await loadLicense(true)
      const l = await api().backend.getLifecycle()
      setLifecycle(l)
    } catch {
      /* stay on the error screen */
    } finally {
      setBusy(false)
    }
  }

  switch (screen.kind) {
    case 'loading':
      return <Starting title="Opening AirBridge" body="Just a moment…" />
    case 'signin':
      return <SignIn signingIn={screen.signingIn} busy={busy} error={signInError} onSignIn={signIn} />
    case 'checking':
      return <Starting title="Checking your subscription" body="This only takes a second." />
    case 'paywall':
      return <Paywall user={auth?.user} onRecheck={async () => isActive(await loadLicense(true))} />
    case 'starting':
      return <Starting />
    case 'tailscale':
      return (
        <ErrorScreen
          icon={<WifiOffIcon size={28} />}
          title="Tailscale is off"
          body="AirBridge uses Tailscale to reach your other computers, and it isn’t connected right now."
          step="Open Tailscale and sign in"
          onAction={retryBackend}
          busy={busy}
        />
      )
    case 'crashed':
      return (
        <ErrorScreen
          title="AirBridge stopped unexpectedly"
          body="It usually recovers on its own. If it doesn’t, try again — or quit and reopen the app."
          onAction={retryBackend}
          busy={busy}
          detail={screen.detail}
        />
      )
    case 'ready':
      return <MainShell user={auth?.user} license={license} lifecycle={lifecycle} />
  }
}
