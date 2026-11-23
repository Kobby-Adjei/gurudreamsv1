import { render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { describe, expect, it } from 'vitest'
import App from '../../src/renderer/App'
import { PrivateNetworkCard } from '../../src/renderer/components/PrivateNetworkCard'
import { SendTaskSheet } from '../../src/renderer/components/SendTaskSheet'
import { ToastProvider } from '../../src/renderer/components/Toast'
import { MainShell } from '../../src/renderer/views/MainShell'
import { SwarmMap } from '../../src/renderer/views/SwarmMap'
import { fixtures, installMockApi } from './setup'

async function expectNoViolations(container: Element) {
  const result = await axe.run(container, {
    // jsdom cannot compute colours; contrast is verified against the token table
    // in styles.css and in the Playwright screenshots instead.
    rules: { 'color-contrast': { enabled: false } }
  })
  const summary = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
  expect(summary).toEqual([])
}

describe('Accessibility (axe-core)', () => {
  it('Sign in', async () => {
    installMockApi({ auth: { state: 'signed_out' } })
    const { container } = render(<App />)
    await screen.findByRole('button', { name: /Sign in to continue/ })
    await expectNoViolations(container)
  })

  it('Paywall', async () => {
    installMockApi({ license: { state: 'inactive', plan: null, exp: null, enforced: true } })
    const { container } = render(<App />)
    await screen.findByRole('button', { name: 'Subscribe' })
    await expectNoViolations(container)
  })

  it('Starting', async () => {
    installMockApi({ lifecycle: { phase: 'starting' } })
    const { container } = render(<App />)
    await screen.findByRole('heading', { name: 'Getting ready' })
    await expectNoViolations(container)
  })

  it('Starting – waiting for the private network', async () => {
    installMockApi({ lifecycle: { phase: 'stopped' }, network: { state: 'connecting' } })
    const { container } = render(<App />)
    await screen.findByText('Connecting your private network')
    await expectNoViolations(container)
  })

  it('Private network error screen', async () => {
    installMockApi({ lifecycle: { phase: 'stopped' }, network: { state: 'error', detail: 'gave up' } })
    const { container } = render(<App />)
    await screen.findByRole('heading', { name: 'Couldn’t connect your devices' })
    await expectNoViolations(container)
  })

  it('Private network card – error with details open', async () => {
    const { container } = render(
      <main>
        <PrivateNetworkCard network={{ status: { state: 'error', detail: 'gave up', ip: '100.64.0.1' }, available: true, retrying: false, retry: async () => {} }} />
      </main>
    )
    container.querySelector('details')!.open = true
    await expectNoViolations(container)
  })

  for (const view of ['swarm', 'activity', 'settings'] as const) {
    it(`Main app – ${view}`, async () => {
      const mock = installMockApi()
      const { container } = render(
        <ToastProvider>
          <MainShell user={fixtures.user} license={mock.state.license} lifecycle={{ phase: 'running' }} initialView={view} />
        </ToastProvider>
      )
      await screen.findByRole('heading', { level: 1 })
      if (view === 'swarm') await screen.findAllByText('Online')
      if (view === 'activity') await screen.findByText('Received task from MacBook')
      if (view === 'settings') await screen.findByText(/"mcpServers"/)
      await expectNoViolations(container)
    })
  }

  it('Devices empty state', async () => {
    const { container } = render(
      <main>
        <SwarmMap data={{ ...fixtures.nodes(), nodes: [] }} loading={false} platform="darwin" onRetry={() => {}} onSendTask={() => {}} />
      </main>
    )
    await expectNoViolations(container)
  })

  it('Send task sheet', async () => {
    installMockApi()
    const { container } = render(
      <ToastProvider>
        <SendTaskSheet open nodes={fixtures.nodes().nodes} onClose={() => {}} />
      </ToastProvider>
    )
    await expectNoViolations(container)
  })
})
