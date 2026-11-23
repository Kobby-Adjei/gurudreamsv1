import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { describe, expect, it } from 'vitest'
import App, { deriveScreen } from '../../src/renderer/App'
import { isEnforced, isPreview, networkMode, SYSTEM_NETWORK_HINT } from '../../src/renderer/lib/preview'
import { fixtures, installMockApi } from './setup'

/** Preview build (PHASE3_PLAN.md §8): the licence is checked but never gates anything. */
const previewInactive = { state: 'inactive' as const, plan: null, exp: null, enforced: false }
const previewValid = { state: 'valid' as const, plan: 'airbridge_pro', exp: 2_000_000_000, enforced: false }
const enforcedValid = { ...previewValid, enforced: true }
const signedOut = { state: 'signed_out' as const }
const signedIn = { state: 'signed_in' as const, user: fixtures.user }
const VENDOR = /tailscale/i

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

  it('picks the network: embedded unless preview, then main’s word, else signed in → embedded', () => {
    expect(networkMode(enforcedValid, signedOut, null)).toBe('embedded')
    expect(networkMode(previewValid, signedOut, null)).toBe('system')
    expect(networkMode(previewValid, signedIn, null)).toBe('embedded')
    expect(networkMode(previewValid, signedIn, { state: 'stopped', mode: 'system' })).toBe('system')
    expect(networkMode(previewValid, signedOut, { state: 'connected', mode: 'embedded' })).toBe('embedded')
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

  it('on the computer’s own network there’s only the service step; with our network, both', () => {
    const steps = (auth: typeof signedIn | typeof signedOut) => {
      const s = deriveScreen(auth, previewInactive, { phase: 'starting' }, { state: 'stopped' })
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
  it('signed out: goes straight from Starting to the app, with a quiet Sign in and “Preview”', async () => {
    const mock = installMockApi({ auth: signedOut, license: previewInactive, lifecycle: { phase: 'starting' }, network: { state: 'stopped' } })
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Getting ready' })).toBeInTheDocument()
    expect(screen.queryByText('Connecting your private network')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Sign in to continue/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Subscribe' })).not.toBeInTheDocument()

    act(() => mock.emitLifecycle({ phase: 'running' }))
    expect(await screen.findByRole('heading', { name: 'Your devices' })).toBeInTheDocument()
    const f = within(footer())
    expect(f.getByText('Preview')).toBeInTheDocument()
    expect(f.queryByText('Pro')).not.toBeInTheDocument()
    // Main reports the computer's own network through the same status line.
    act(() => mock.emitNetwork({ state: 'connected', ip: '100.64.0.7' }))
    await waitFor(() => expect(screen.getByTestId('network-line')).toHaveTextContent('Private network · Connected'))
    await userEvent.click(f.getByRole('button', { name: 'Sign in' }))
    expect(mock.api.auth.signIn).toHaveBeenCalledOnce()

    act(() => mock.emitAuth({ state: 'signing_in' }))
    expect(await within(footer()).findByText(/Finish signing in/)).toBeInTheDocument()
    // Still in the app — signing in never puts a wall up.
    expect(screen.getByRole('heading', { name: 'Your devices' })).toBeInTheDocument()
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
  })

  it('Settings → Account explains the preview; Plans opens the Paywall as a page with Back', async () => {
    const mock = installMockApi({ auth: signedOut, license: previewInactive })
    render(<App />)
    await screen.findByRole('heading', { name: 'Your devices' })
    await userEvent.click(screen.getByRole('button', { name: /Settings/ }))
    const account = screen.getByRole('region', { name: 'Account' })
    expect(within(account).getByText('AirBridge is in preview — everything is unlocked while we test.')).toBeInTheDocument()
    expect(within(account).getByText('Optional')).toBeInTheDocument()
    expect(within(account).queryByRole('button', { name: /Manage subscription/ })).not.toBeInTheDocument()
    await userEvent.click(within(account).getByRole('button', { name: 'Sign in' }))
    expect(mock.api.auth.signIn).toHaveBeenCalledOnce()

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
    expect(within(account).queryByText('Optional')).not.toBeInTheDocument()
  })
})

describe('Preview network trouble copy', () => {
  const nodesError = { ...fixtures.nodes(), nodes: [], error: 'status failed' }

  it('system mode: devices map and Settings name the one thing to check', async () => {
    installMockApi({ auth: signedOut, license: previewInactive, nodes: nodesError, network: { state: 'stopped' } })
    render(<App />)
    expect(await screen.findByText(SYSTEM_NETWORK_HINT)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Settings/ }))
    const card = screen.getByRole('region', { name: 'Private network' })
    expect(within(card).getByText('Can’t see other devices')).toBeInTheDocument()
    expect(within(card).getByText(SYSTEM_NETWORK_HINT)).toBeInTheDocument()
  })

  it('system mode: Settings follows the status main reports, with no hint while it’s fine', async () => {
    const mock = installMockApi({ auth: signedOut, license: previewInactive, network: { state: 'connected' } })
    render(<App />)
    await screen.findByRole('heading', { name: 'Your devices' })
    await userEvent.click(screen.getByRole('button', { name: /Settings/ }))
    const card = screen.getByRole('region', { name: 'Private network' })
    expect(within(card).getByText('Connected')).toBeInTheDocument()
    expect(within(card).queryByText(SYSTEM_NETWORK_HINT)).not.toBeInTheDocument()
    act(() => mock.emitNetwork({ state: 'connecting' }))
    expect(await within(card).findByText('Connecting…')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(VENDOR)
  })

  it('system mode: no trouble, no hint', async () => {
    installMockApi({ auth: signedOut, license: previewInactive, network: { state: 'stopped' } })
    render(<App />)
    await screen.findAllByText('Online')
    expect(document.body.textContent).not.toMatch(VENDOR)
  })

  it('system mode: the network error screen uses the hint as its step', async () => {
    installMockApi({ auth: signedOut, license: previewInactive, lifecycle: { phase: 'stopped' }, network: { state: 'error', mode: 'system' } })
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Couldn’t connect your devices' })).toBeInTheDocument()
    expect(screen.getByText(SYSTEM_NETWORK_HINT)).toBeInTheDocument()
  })

  it('system mode: a crashed service also gets the hint', async () => {
    installMockApi({ auth: signedOut, license: previewInactive, lifecycle: { phase: 'crashed' }, network: { state: 'stopped' } })
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'AirBridge stopped unexpectedly' })).toBeInTheDocument()
    expect(screen.getByText(SYSTEM_NETWORK_HINT)).toBeInTheDocument()
  })

  it('preview but signed in (our own network): invisible-network copy, no vendor', async () => {
    installMockApi({ license: previewInactive, nodes: nodesError })
    render(<App />)
    expect(await screen.findByText('Your private network is still connecting.')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(VENDOR)
  })

  it('enforced: invisible-network copy, no vendor', async () => {
    installMockApi({ license: enforcedValid, nodes: nodesError, lifecycle: { phase: 'crashed' } })
    render(<App />)
    await screen.findByRole('heading', { name: 'AirBridge stopped unexpectedly' })
    expect(document.body.textContent).not.toMatch(VENDOR)
  })
})

describe('Preview accessibility (axe-core)', () => {
  it('Devices, signed out', async () => {
    installMockApi({ auth: signedOut, license: previewInactive, network: { state: 'stopped' } })
    const { container } = render(<App />)
    await screen.findAllByText('Online')
    await expectNoViolations(container)
  })

  it('Settings, signed out with network trouble', async () => {
    installMockApi({ auth: signedOut, license: previewInactive, nodes: { ...fixtures.nodes(), nodes: [], error: 'x' }, network: { state: 'stopped' } })
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
