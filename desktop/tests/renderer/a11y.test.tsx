import { render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { describe, expect, it } from 'vitest'
import App from '../../src/renderer/App'
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
    installMockApi({ license: { state: 'inactive', plan: null, exp: null } })
    const { container } = render(<App />)
    await screen.findByRole('button', { name: 'Subscribe' })
    await expectNoViolations(container)
  })

  it('Starting', async () => {
    installMockApi({ lifecycle: { phase: 'starting' } })
    const { container } = render(<App />)
    await screen.findByRole('heading', { name: 'Starting AirBridge' })
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
