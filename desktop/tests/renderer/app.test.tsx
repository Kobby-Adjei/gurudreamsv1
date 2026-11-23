import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import App, { deriveScreen } from '../../src/renderer/App'
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
    expect(deriveScreen(signedIn, valid, { phase: 'crashed', detail: 'Tailscale is not running' }).kind).toBe('tailscale')
    expect(deriveScreen(signedIn, valid, { phase: 'crashed', detail: 'exit code 1' }).kind).toBe('crashed')
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
    expect(await screen.findByRole('heading', { name: 'Starting AirBridge' })).toBeInTheDocument()
  })

  it('shows Starting while the backend spins up, then the main app when ready', async () => {
    const mock = installMockApi({ license: valid, lifecycle: { phase: 'starting' } })
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Starting AirBridge' })).toBeInTheDocument()
    act(() => mock.emitLifecycle({ phase: 'running' }))
    expect(await screen.findByRole('heading', { name: 'Your swarm' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument()
    expect(screen.getByRole('main')).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByText('Online').length).toBeGreaterThanOrEqual(2))
  })

  it('shows a Tailscale error with one next action and Retry', async () => {
    const mock = installMockApi({ license: valid, lifecycle: { phase: 'crashed', detail: 'tailscale: NeedsLogin' } })
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Tailscale is off' })).toBeInTheDocument()
    expect(screen.getByText('Open Tailscale and sign in')).toBeInTheDocument()
    mock.state.lifecycle = { phase: 'running' }
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('heading', { name: 'Your swarm' })).toBeInTheDocument()
  })

  it('is fully keyboard navigable in the main app', async () => {
    installMockApi({ license: valid, lifecycle: { phase: 'running' } })
    render(<App />)
    await screen.findByRole('heading', { name: 'Your swarm' })
    const user = userEvent.setup()
    await user.tab() // skip link
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: /Swarm/ })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: /Activity/ })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('heading', { name: 'Activity' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Activity/ })).toHaveAttribute('aria-current', 'page')
    await user.keyboard('{Control>}3{/Control}')
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument()
  })
})
