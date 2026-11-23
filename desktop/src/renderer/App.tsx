import { useCallback, useEffect, useRef, useState } from 'react'
import type { AuthState, BackendLifecycle, Unsubscribe } from '../shared/types'
import { WifiOffIcon } from './components/Icons'
import { ToastProvider } from './components/Toast'
import { api, errorText } from './lib/api'
import { useNetworkStatus, type NetStatus } from './lib/network'
import { isEnforced, needsSignIn, type LicenseView } from './lib/preview'
import { ErrorScreen } from './views/ErrorScreen'
import { MainShell } from './views/MainShell'
import { Paywall } from './views/Paywall'
import { SignIn } from './views/SignIn'
import { Starting, type StartStep } from './views/Starting'

/**
 * App-level state machine, derived purely from the main-process sources of
 * truth (auth, licence gate, private network, backend lifecycle):
 *
 *   loading ─▶ signin ─▶ checking ─▶ paywall
 *                              └───▶ starting ─▶ ready
 *                                          └───▶ network | crashed
 *
 * While starting, two quiet steps follow the network and then the backend.
 *
 * Preview (license.enforced === false, PHASE3_PLAN.md §8) never shows the
 * sign-in wall or the Paywall:
 *
 *   loading ─▶ starting ─▶ ready
 *                    └───▶ network | crashed
 */
export type Screen =
  | { kind: 'loading' }
  | { kind: 'signin'; signingIn: boolean }
  | { kind: 'checking' }
  | { kind: 'paywall' }
  | { kind: 'starting'; steps: StartStep[] }
  | { kind: 'network'; detail?: string }
  | { kind: 'crashed'; detail?: string }
  | { kind: 'ready' }

export const START_STEPS = ['Connecting your private network', 'Starting AirBridge'] as const

/**
 * Two steps: the network comes up first, then the background service.
 * With `ownNetwork: false` (preview, signed out: the network waits for a
 * sign-in) there is nothing to wait for, so only the service step is shown.
 */
export function startSteps(
  network: NetStatus | null | undefined,
  lifecycle: BackendLifecycle | null,
  ownNetwork = true
): StartStep[] {
  // Without a network bridge (older preload) there is nothing to wait for.
  const netDone = network === undefined || network?.state === 'connected'
  const backendDone = lifecycle?.phase === 'running'
  if (!ownNetwork) return [{ label: START_STEPS[1], state: backendDone ? 'done' : 'active' }]
  return [
    { label: START_STEPS[0], state: netDone || backendDone ? 'done' : 'active' },
    { label: START_STEPS[1], state: backendDone ? 'done' : netDone ? 'active' : 'pending' }
  ]
}

/**
 * `network` is `undefined` when the preload has no network surface, `null`
 * while its first status is still on the way.
 */
export function deriveScreen(
  auth: AuthState | null,
  license: LicenseView | null,
  lifecycle: BackendLifecycle | null,
  network?: NetStatus | null
): Screen {
  if (!auth) return { kind: 'loading' }
  if (!isEnforced(license)) return derivePreview(auth, license, lifecycle, network)
  // Until the licence answers we don't know whether sign-in is required.
  if (!license && auth.state !== 'signed_in') return { kind: 'loading' }
  if (auth.state !== 'signed_in') return { kind: 'signin', signingIn: auth.state === 'signing_in' }
  if (!license || license.state === 'unknown') return { kind: 'checking' }
  if (license.state === 'inactive') return { kind: 'paywall' }
  if (network?.state === 'error') return { kind: 'network', detail: network.detail }
  if (!lifecycle) return { kind: 'starting', steps: startSteps(network, lifecycle) }
  switch (lifecycle.phase) {
    case 'running':
      return { kind: 'ready' }
    case 'crashed':
      return { kind: 'crashed', detail: lifecycle.detail }
    case 'blocked':
      return { kind: 'paywall' }
    default:
      return { kind: 'starting', steps: startSteps(network, lifecycle) }
  }
}

/** Preview: nothing is gated. Straight to Starting, then the app. */
function derivePreview(
  auth: AuthState,
  license: LicenseView | null,
  lifecycle: BackendLifecycle | null,
  network?: NetStatus | null
): Screen {
  // Signed out, the network waits for a sign-in that happens inside the app.
  const own = !needsSignIn(license, auth)
  if (network?.state === 'error') return { kind: 'network', detail: network.detail }
  switch (lifecycle?.phase) {
    case 'running':
      return { kind: 'ready' }
    case 'crashed':
      return { kind: 'crashed', detail: lifecycle.detail }
    default:
      // 'blocked' shouldn't happen in preview; never show a wall for it.
      return { kind: 'starting', steps: startSteps(network, lifecycle, own) }
  }
}

const isActive = (l: LicenseView | null) => l?.state === 'valid' || l?.state === 'grace'

export default function App() {
  return (
    <ToastProvider>
      <AppStates />
    </ToastProvider>
  )
}

function AppStates() {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [license, setLicense] = useState<LicenseView | null>(null)
  const [lifecycle, setLifecycle] = useState<BackendLifecycle | null>(null)
  const [busy, setBusy] = useState(false)
  const [signInError, setSignInError] = useState<string | null>(null)
  const alive = useRef(true)
  const network = useNetworkStatus()

  const loadLicense = useCallback(async (refresh = false) => {
    try {
      const l: LicenseView = refresh ? await api().license.refresh() : await api().license.getStatus()
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
    // license.onChange pushes ab:license:changed, so the Paywall → Starting
    // transition is instant after subscribing ("check again" stays as fallback).
    const offLicense: Unsubscribe | undefined = a.license.onChange?.((l: LicenseView) => {
      if (alive.current) setLicense(l)
    })
    return () => {
      alive.current = false
      offAuth()
      offLife()
      offLicense?.()
    }
  }, [loadLicense])

  const netStatus = network.available ? network.status : undefined
  const screen = deriveScreen(auth, license, lifecycle, netStatus)
  const enforced = isEnforced(license)

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
      if (screen.kind === 'network') await network.retry()
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
      return <Starting title="Getting ready" steps={screen.steps} />
    case 'network':
      return (
        <ErrorScreen
          icon={<WifiOffIcon size={28} />}
          title="Couldn’t connect your devices"
          body="AirBridge links your computers through its own private network, and it couldn’t start just now."
          step="Check that this computer is online, then press Retry."
          onAction={retryBackend}
          busy={busy || network.retrying}
          detail={screen.detail}
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
      return (
        <MainShell
          user={auth?.user}
          license={license}
          lifecycle={lifecycle}
          preview={
            enforced
              ? undefined
              : {
                  auth: auth ?? { state: 'signed_out' },
                  onRecheck: async () => isActive(await loadLicense(true))
                }
          }
        />
      )
  }
}
