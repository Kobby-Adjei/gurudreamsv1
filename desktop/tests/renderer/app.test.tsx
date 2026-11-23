import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import App, { deriveScreen, startSteps } from '../../src/renderer/App'
import { installMockApi } from './setup'

const valid = { state: 'valid' as const, plan: 'airbridge_pro', exp: 2_000_000_000 }
const inactive = { state: 'inactive' as const, plan: null, exp: null }

describe('App state machine', () => {
  it('derives each screen from auth / licence / lifecycle', () => {
    const signedIn = { state: 'signed_in' as const }
    expect(deriveScreen(null, null, null).kind).toBe('loading')
    expect(deriveScreen({ state: 'signed_out' }, null, null)).toEqual({ kind: 'signin', signingIn: false })
    expect(deriveScreen({ state: 'signing_in' }, null, null)).toEqual({ kind: 'signin', signingIn: true })
    expect(deriveScreen(signedIn, { state: 'unknown', plan: null, exp: null }, null).kind).toBe('checking')
    expect(deriveScreen(signedIn, inactive, { phase: 'stopped' }).kind).toBe('paywall')
    expect(deriveScreen(signedIn, valid, { phase: 'starting' }).kind).toBe('starting')
    expect(deriveScreen(signedIn, valid, { phase: 'stopped' }).kind).toBe('starting')
    expect(deriveScreen(signedIn, { ...valid, state: 'grace' }, { phase: 'running' }).kind).toBe('ready')
    expect(deriveScreen(signedIn, valid, { phase: 'crashed', detail: 'exit code 1' }).kind).toBe('crashed')
    expect(deriveScreen(signedIn, valid, { phase: 'blocked' }).kind).toBe('paywall')
    // The private network (Phase 3)
    expect(deriveScreen(signedIn, valid, { phase: 'starting' }, { state: 'error', detail: 'x' })).toEqual({ kind: 'network', detail: 'x' })
    expect(deriveScreen(signedIn, valid, { phase: 'running' }, { state: 'error' }).kind).toBe('network')
    expect(deriveScreen(signedIn, inactive, { phase: 'stopped' }, { state: 'error' }).kind).toBe('paywall')
    expect(deriveScreen(signedIn, valid, { phase: 'stopped' }, { state: 'connecting' }).kind).toBe('starting')
    expect(deriveScreen(signedIn, valid, { phase: 'running' }, { state: 'connected' }).kind).toBe('ready')
  })

  it('drives the two start-up steps from the network, then the backend', () => {
    const states = (n: Parameters<typeof startSteps>[0], l: Parameters<typeof startSteps>[1]) =>
      startSteps(n, l).map((s) => s.state)
    expect(startSteps(null, null).map((s) => s.label)).toEqual(['Connecting your private network', 'Starting AirBridge'])
    expect(states(null, null)).toEqual(['active', 'pending'])
    expect(states({ state: 'needs_login' }, { phase: 'stopped' })).toEqual(['active', 'pending'])
    expect(states({ state: 'connected' }, { phase: 'starting' })).toEqual(['done', 'active'])
    expect(states({ state: 'connected' }, { phase: 'running' })).toEqual(['done', 'done'])
    // Older preload without a network surface: nothing to wait for.
    expect(states(undefined, { phase: 'starting' })).toEqual(['done', 'active'])
  })

  it('shows Sign in when signed out, and calls auth.signIn', async () => {
    const mock = installMockApi({ auth: { state: 'signed_out' }, license: inactive, lifecycle: { phase: 'stopped' } })
    render(<App />)
    const btn = await screen.findByRole('button', { name: /Sign in to continue/ })
    expect(screen.getByRole('heading', { name: 'Welcome to AirBridge' })).toBeInTheDocument()
    await userEvent.click(btn)
    expect(mock.api.auth.signIn).toHaveBeenCalledOnce()

    act(() => mock.emitAuth({ state: 'signing_in' }))
    expect(await screen.findByText(/Finish signing in in the browser/)).toBeInTheDocument()
  })

  it('shows the Paywall when the licence is inactive', async () => {
    const mock = installMockApi({ license: inactive, lifecycle: { phase: 'stopped' } })
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'AirBridge Pro' })).toBeInTheDocument()
    expect(screen.getByText('$15')).toBeInTheDocument()
    expect(screen.getByText('/ month')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Subscribe' }))
    expect(mock.api.license.openCheckout).toHaveBeenCalledOnce()

    await userEvent.click(screen.getByRole('button', { name: /I’ve subscribed — check again/ }))
    expect(mock.api.license.refresh).toHaveBeenCalled()
    expect(await screen.findByText(/couldn’t find an active subscription yet/)).toBeInTheDocument()

    // Subscription goes through → re-check unlocks the app.
    mock.state.license = valid
    mock.state.lifecycle = { phase: 'starting' }
    await userEvent.click(screen.getByRole('button', { name: /I’ve subscribed — check again/ }))
    expect(await screen.findByRole('heading', { name: 'Getting ready' })).toBeInTheDocument()
  })

  it('moves from Paywall to Starting instantly when license.onChange pushes', async () => {
    const mock = installMockApi({ license: inactive, lifecycle: { phase: 'stopped' } })
    render(<App />)
    await screen.findByRole('button', { name: 'Subscribe' })
    mock.state.lifecycle = { phase: 'starting' }
    act(() => mock.emitLicense(valid))
    expect(await screen.findByRole('heading', { name: 'Getting ready' })).toBeInTheDocument()
  })

  it('shows Starting while the backend spins up, then the main app when ready', async () => {
    const mock = installMockApi({ license: valid, lifecycle: { phase: 'starting' } })
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Getting ready' })).toBeInTheDocument()
    act(() => mock.emitLifecycle({ phase: 'running' }))
    expect(await screen.findByRole('heading', { name: 'Your devices' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument()
    expect(screen.getByRole('main')).toBeInTheDocument()
    expect(await screen.findByLabelText('2 online')).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByText('Online').length).toBeGreaterThanOrEqual(2))
  })

  it('walks through the start-up steps as the network and backend come up', async () => {
    const mock = installMockApi({ license: valid, lifecycle: { phase: 'stopped' }, network: { state: 'connecting' } })
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Getting ready' })).toBeInTheDocument()
    const step = (name: string) => screen.getByText(name).closest('li')!
    await waitFor(() => expect(step('Connecting your private network')).toHaveAttribute('data-step', 'active'))
    expect(step('Starting AirBridge')).toHaveAttribute('data-step', 'pending')
    act(() => mock.emitNetwork({ state: 'connected', ip: '100.64.0.9' }))
    act(() => mock.emitLifecycle({ phase: 'starting' }))
    expect(step('Connecting your private network')).toHaveAttribute('data-step', 'done')
    expect(step('Starting AirBridge')).toHaveAttribute('data-step', 'active')
    act(() => mock.emitLifecycle({ phase: 'running' }))
    expect(await screen.findByRole('heading', { name: 'Your devices' })).toBeInTheDocument()
    expect(await screen.findByTestId('network-line')).toHaveTextContent('Private network · Connected')
  })

  it('shows a network error with one next action and Retry', async () => {
    const mock = installMockApi({ license: valid, lifecycle: { phase: 'stopped' }, network: { state: 'error', detail: 'daemon exited' } })
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Couldn’t connect your devices' })).toBeInTheDocument()
    expect(screen.getByText('Check that this computer is online, then press Retry.')).toBeInTheDocument()
    expect(screen.getByText('daemon exited')).not.toBeVisible()
    mock.state.network = { state: 'connected' }
    mock.state.lifecycle = { phase: 'running' }
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('heading', { name: 'Your devices' })).toBeInTheDocument()
  })

  it('the sidebar follows the private network while the app is open', async () => {
    const mock = installMockApi({ license: valid, lifecycle: { phase: 'running' } })
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('network-line')).toHaveTextContent('Private network · Connected'))
    act(() => mock.emitNetwork({ state: 'connecting' }))
    await waitFor(() => expect(screen.getByTestId('network-line')).toHaveTextContent('Private network · Connecting…'))
  })

  it('is fully keyboard navigable in the main app', async () => {
    installMockApi({ license: valid, lifecycle: { phase: 'running' } })
    render(<App />)
    await screen.findByRole('heading', { name: 'Your devices' })
    const user = userEvent.setup()
    await user.tab() // skip link
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: /^Devices/ })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: /Activity/ })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('heading', { name: 'Activity' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Activity/ })).toHaveAttribute('aria-current', 'page')
    await user.keyboard('{Control>}3{/Control}')
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument()
  })
})
