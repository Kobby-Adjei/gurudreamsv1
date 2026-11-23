import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { describe, expect, it, vi } from 'vitest'
import App, { deriveScreen } from '../../src/renderer/App'
import { isEnforced, isPreview, needsSignIn } from '../../src/renderer/lib/preview'
import { fixtures, installMockApi } from './setup'

/** Preview build (PHASE3_PLAN.md §8): the licence is checked but never gates anything. */
const previewInactive = { state: 'inactive' as const, plan: null, exp: null, enforced: false }
const previewValid = { state: 'valid' as const, plan: 'airbridge_pro', exp: 2_000_000_000, enforced: false }
const enforcedValid = { ...previewValid, enforced: true }
const signedOut = { state: 'signed_out' as const }
const signedIn = { state: 'signed_in' as const, user: fixtures.user }
const VENDOR = /tailscale|tailnet/i
/** What main reports in preview while signed out (PHASE3_PLAN.md §9). */
const needsLogin = { state: 'needs_login' as const, mode: 'embedded' as const }
const PROMPT = 'Sign in to connect your devices'
const PROMPT_BODY = 'Sign in once on each computer — AirBridge connects them privately. Nothing else to install.'

async function expectNoViolations(container: Element) {
  const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
}

const footer = () => screen.getByRole('complementary')

describe('Preview helpers', () => {
  it('treats a missing or true `enforced` as enforced; only an explicit false is preview', () => {
    expect(isEnforced(null)).toBe(true)
    expect(isEnforced({ state: 'valid', plan: null, exp: null })).toBe(true)
    expect(isEnforced(enforcedValid)).toBe(true)
    expect(isEnforced(previewInactive)).toBe(false)
    expect(isPreview(null)).toBe(false)
    expect(isPreview(previewInactive)).toBe(true)
  })

  it('asks for sign-in in place only in preview while signed out', () => {
    expect(needsSignIn(enforcedValid, signedOut)).toBe(false)
    expect(needsSignIn(null, signedOut)).toBe(false)
    expect(needsSignIn(previewValid, signedOut)).toBe(true)
    expect(needsSignIn(previewValid, { state: 'signing_in' })).toBe(true)
    expect(needsSignIn(previewValid, signedIn)).toBe(false)
  })
})

describe('Preview state machine', () => {
  it('never derives the sign-in wall or the Paywall', () => {
    for (const auth of [signedOut, { state: 'signing_in' as const }, signedIn]) {
      for (const license of [previewInactive, previewValid, { ...previewValid, state: 'unknown' as const }]) {
        for (const phase of ['stopped', 'starting', 'blocked'] as const) {
          expect(deriveScreen(auth, license, { phase }).kind).toBe('starting')
        }
        expect(deriveScreen(auth, license, null).kind).toBe('starting')
        expect(deriveScreen(auth, license, { phase: 'running' }).kind).toBe('ready')
        expect(deriveScreen(auth, license, { phase: 'crashed', detail: 'x' })).toEqual({ kind: 'crashed', detail: 'x' })
        expect(deriveScreen(auth, license, { phase: 'running' }, { state: 'error', detail: 'y' })).toEqual({ kind: 'network', detail: 'y' })
      }
    }
  })

  it('signed out there’s no network to wait for, only the service step; signed in, both', () => {
    const steps = (auth: typeof signedIn | typeof signedOut) => {
      const s = deriveScreen(auth, previewInactive, { phase: 'starting' }, auth.state === 'signed_in' ? { state: 'stopped' } : needsLogin)
      return s.kind === 'starting' ? s.steps.map((x) => `${x.label}:${x.state}`) : s.kind
    }
    expect(steps(signedOut)).toEqual(['Starting AirBridge:active'])
    expect(steps(signedIn)).toEqual(['Connecting your private network:active', 'Starting AirBridge:pending'])
  })

  it('enforced is unchanged: signed out → Sign in, inactive → Paywall', () => {
    expect(deriveScreen(signedOut, { ...enforcedValid, state: 'inactive' }, null).kind).toBe('signin')
    expect(deriveScreen(signedIn, { ...enforcedValid, state: 'inactive' }, { phase: 'stopped' }).kind).toBe('paywall')
  })
})

describe('Preview app', () => {
  it('signed out: Starting → the app, Devices asks to sign in, footer says so too', async () => {
    const mock = installMockApi({ auth: signedOut, license: previewInactive, lifecycle: { phase: 'starting' }, network: needsLogin })
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Getting ready' })).toBeInTheDocument()
    expect(screen.queryByText('Connecting your private network')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Sign in to continue/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Subscribe' })).not.toBeInTheDocument()

    act(() => mock.emitLifecycle({ phase: 'running' }))
    expect(await screen.findByRole('heading', { name: 'Your devices' })).toBeInTheDocument()
    // Calm inline prompt, not a wall: the sidebar is right there.
    const main = within(screen.getByRole('main'))
    expect(main.getByRole('heading', { name: PROMPT })).toBeInTheDocument()
    expect(main.getByText(PROMPT_BODY)).toBeInTheDocument()
    expect(main.getAllByRole('button').map((b) => b.textContent)).toEqual(['Sign in'])
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument()

    const f = within(footer())
    expect(f.getByText('Preview')).toBeInTheDocument()
    expect(f.getByText('Not signed in')).toBeInTheDocument()
    expect(f.queryByText('Pro')).not.toBeInTheDocument()
    expect(screen.getByTestId('network-line')).toHaveTextContent('Private network · Sign in to connect')
    // One Sign in in the footer: the text button on the network line.
    expect(f.getAllByRole('button', { name: 'Sign in' })).toHaveLength(1)
    await userEvent.click(within(screen.getByTestId('network-line')).getByRole('button', { name: 'Sign in' }))
    expect(mock.api.auth.signIn).toHaveBeenCalledOnce()

    await userEvent.click(main.getByRole('button', { name: 'Sign in' }))
    expect(mock.api.auth.signIn).toHaveBeenCalledTimes(2)

    act(() => mock.emitAuth({ state: 'signing_in' }))
    expect(await within(footer()).findByText(/Finish signing in/)).toBeInTheDocument()
    expect(within(screen.getByTestId('network-line')).queryByRole('button')).not.toBeInTheDocument()
    expect(within(screen.getByRole('main')).getByText(/Finish signing in in your browser/)).toBeInTheDocument()
    // Still in the app — signing in never puts a wall up.
    expect(screen.getByRole('heading', { name: 'Your devices' })).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(VENDOR)

    // Signed in: the prompt goes away and the network line follows main again.
    act(() => mock.emitAuth(signedIn))
    act(() => mock.emitNetwork({ state: 'connected', ip: '100.64.0.7', mode: 'embedded' }))
    await waitFor(() => expect(screen.getByTestId('network-line')).toHaveTextContent('Private network · Connected'))
    expect(screen.queryByRole('heading', { name: PROMPT })).not.toBeInTheDocument()
  })

  it('a failed sign-in start shows a calm toast, no vendor words', async () => {
    const mock = installMockApi({ auth: signedOut, license: previewInactive, network: needsLogin })
    vi.mocked(mock.api.auth.signIn).mockRejectedValueOnce(new Error('browser unavailable'))
    render(<App />)
    await screen.findByRole('heading', { name: PROMPT })
    await userEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Couldn’t start sign-in')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(VENDOR)
  })

  it('signed in: name + “Preview” in the footer, private network line as usual', async () => {
    installMockApi({ license: previewInactive })
    render(<App />)
    await screen.findByRole('heading', { name: 'Your devices' })
    const f = within(footer())
    expect(f.getByText('Grace Hopper')).toBeInTheDocument()
    expect(f.getByText('Preview')).toBeInTheDocument()
    expect(f.queryByText('Free')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('network-line')).toHaveTextContent('Private network · Connected'))
    expect(screen.queryByRole('heading', { name: PROMPT })).not.toBeInTheDocument()
  })

  it('Settings: the network card asks for sign-in; Account explains the preview; Plans opens as a page', async () => {
    const mock = installMockApi({ auth: signedOut, license: previewInactive, network: needsLogin })
    render(<App />)
    await screen.findByRole('heading', { name: 'Your devices' })
    await userEvent.click(screen.getByRole('button', { name: /Settings/ }))

    const card = screen.getByRole('region', { name: 'Private network' })
    expect(within(card).getByText('Sign in to connect')).toBeInTheDocument()
    expect(within(card).getByText(PROMPT_BODY)).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    await userEvent.click(within(card).getByRole('button', { name: 'Sign in' }))
    expect(mock.api.auth.signIn).toHaveBeenCalledOnce()

    const account = screen.getByRole('region', { name: 'Account' })
    expect(within(account).getByText('AirBridge is in preview — everything is unlocked while we test.')).toBeInTheDocument()
    expect(within(account).getByText('To connect your devices')).toBeInTheDocument()
    expect(within(account).queryByRole('button', { name: /Manage subscription/ })).not.toBeInTheDocument()
    await userEvent.click(within(account).getByRole('button', { name: 'Sign in' }))
    expect(mock.api.auth.signIn).toHaveBeenCalledTimes(2)

    await userEvent.click(within(account).getByRole('button', { name: 'Plans' }))
    expect(await screen.findByRole('heading', { name: 'AirBridge Pro' })).toHaveFocus()
    expect(screen.getByText('$15')).toBeInTheDocument()
    // Non-blocking: the sidebar is still there.
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Subscribe' }))
    expect(mock.api.license.openCheckout).toHaveBeenCalledOnce()

    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument()

    await userEvent.click(within(screen.getByRole('region', { name: 'Account' })).getByRole('button', { name: 'Plans' }))
    await screen.findByRole('heading', { name: 'AirBridge Pro' })
    await userEvent.keyboard('{Escape}')
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(VENDOR)
  })

  it('signed in: Account shows the email and Sign out, still no subscription controls', async () => {
    installMockApi({ license: previewValid })
    render(<App />)
    await screen.findByRole('heading', { name: 'Your devices' })
    await userEvent.click(screen.getByRole('button', { name: /Settings/ }))
    const account = screen.getByRole('region', { name: 'Account' })
    expect(within(account).getByText('grace@example.com')).toBeInTheDocument()
    expect(within(account).getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
    expect(within(account).getByRole('button', { name: 'Plans' })).toBeInTheDocument()
    expect(within(account).queryByText('To connect your devices')).not.toBeInTheDocument()
    const card = screen.getByRole('region', { name: 'Private network' })
    expect(within(card).getByText('Connected')).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument()
  })
})

describe('Network trouble copy (no vendor, ever)', () => {
  const nodesError = { ...fixtures.nodes(), nodes: [], error: 'status failed' }

  it('preview, network error: one plain next step', async () => {
    installMockApi({ license: previewInactive, lifecycle: { phase: 'stopped' }, network: { state: 'error', mode: 'embedded' } })
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Couldn’t connect your devices' })).toBeInTheDocument()
    expect(screen.getByText('Check that this computer is online, then press Retry.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(VENDOR)
  })

  it('preview, signed out, network error: same copy', async () => {
    installMockApi({ auth: signedOut, license: previewInactive, lifecycle: { phase: 'stopped' }, network: { state: 'error' } })
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Couldn’t connect your devices' })).toBeInTheDocument()
    expect(screen.getByText('Check that this computer is online, then press Retry.')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(VENDOR)
  })

  it('a crashed service says nothing about the network', async () => {
    installMockApi({ auth: signedOut, license: previewInactive, lifecycle: { phase: 'crashed' }, network: needsLogin })
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'AirBridge stopped unexpectedly' })).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(VENDOR)
  })

  it('preview, signed in, can’t see devices: invisible-network copy', async () => {
    installMockApi({ license: previewInactive, nodes: nodesError })
    render(<App />)
    expect(await screen.findByText('Your private network is still connecting.')).toBeInTheDocument()
    expect(screen.getByText('Check that this computer is online, then press Retry.')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(VENDOR)
  })

  it('preview, signed out, can’t see devices: still just the sign-in prompt', async () => {
    installMockApi({ auth: signedOut, license: previewInactive, nodes: nodesError, network: needsLogin })
    render(<App />)
    expect(await screen.findByRole('heading', { name: PROMPT })).toBeInTheDocument()
    expect(screen.queryByText('Can’t see your other devices right now')).not.toBeInTheDocument()
  })

  it('enforced: invisible-network copy, no vendor', async () => {
    installMockApi({ license: enforcedValid, nodes: nodesError, lifecycle: { phase: 'crashed' } })
    render(<App />)
    await screen.findByRole('heading', { name: 'AirBridge stopped unexpectedly' })
    expect(document.body.textContent).not.toMatch(VENDOR)
  })

  it('enforced + needs_login (enrolling) reads as connecting, never a sign-in prompt', async () => {
    installMockApi({ license: enforcedValid, network: { state: 'needs_login', mode: 'embedded' } })
    render(<App />)
    await screen.findByRole('heading', { name: 'Your devices' })
    await waitFor(() => expect(screen.getByTestId('network-line')).toHaveTextContent('Private network · Connecting…'))
    expect(screen.queryByRole('heading', { name: PROMPT })).not.toBeInTheDocument()
  })
})

describe('Preview accessibility (axe-core)', () => {
  it('Devices, signed out (sign-in prompt)', async () => {
    installMockApi({ auth: signedOut, license: previewInactive, network: needsLogin })
    const { container } = render(<App />)
    await screen.findByRole('heading', { name: PROMPT })
    await expectNoViolations(container)
  })

  it('Settings, signed out', async () => {
    installMockApi({ auth: signedOut, license: previewInactive, network: needsLogin })
    const { container } = render(<App />)
    await screen.findByRole('heading', { name: 'Your devices' })
    await userEvent.click(screen.getByRole('button', { name: /Settings/ }))
    await screen.findByText(/"mcpServers"/)
    await expectNoViolations(container)
  })

  it('Plans page', async () => {
    installMockApi({ license: previewInactive })
    const { container } = render(<App />)
    await screen.findByRole('heading', { name: 'Your devices' })
    await userEvent.click(screen.getByRole('button', { name: /Settings/ }))
    await userEvent.click(within(screen.getByRole('region', { name: 'Account' })).getByRole('button', { name: 'Plans' }))
    await screen.findByRole('heading', { name: 'AirBridge Pro' })
    await expectNoViolations(container)
  })
})
