import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { MainShell } from '../../src/renderer/views/MainShell'
import { ToastProvider } from '../../src/renderer/components/Toast'
import { eventSentence, relativeTime } from '../../src/renderer/lib/format'
import { fixtures, installMockApi } from './setup'

function renderFeed() {
  const mock = installMockApi()
  render(
    <ToastProvider>
      <MainShell user={fixtures.user} license={mock.state.license} lifecycle={{ phase: 'running' }} initialView="activity" />
    </ToastProvider>
  )
  return mock
}

describe('Activity feed', () => {
  it('renders human sentences from events', async () => {
    renderFeed()
    expect(await screen.findByText('Received task from MacBook')).toBeInTheDocument()
    expect(screen.getByText('Sent code to Desktop-PC')).toBeInTheDocument()
    expect(screen.getByText('Couldn’t reach Studio-Mac — is it awake?')).toBeInTheDocument()
    // relative timestamps with a machine-readable datetime
    const list = screen.getByRole('list', { name: 'Activity' })
    expect(within(list).getByText('just now').closest('time')).toHaveAttribute('dateTime')
    expect(within(list).getByText('5 min ago')).toBeInTheDocument()
  })

  it('filters with chips', async () => {
    renderFeed()
    await screen.findByText('Received task from MacBook')
    await userEvent.click(screen.getByRole('button', { name: /Problems/ }))
    expect(screen.getByRole('button', { name: /Problems/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('Received task from MacBook')).toBeNull()
    expect(screen.getByText('Couldn’t reach Studio-Mac — is it awake?')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Sent/ }))
    expect(screen.getByText('Sent code to Desktop-PC')).toBeInTheDocument()
    expect(screen.queryByText(/Couldn’t reach/)).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /Received/ }))
    expect(screen.getByText('Received task from MacBook')).toBeInTheDocument()
    expect(screen.queryByText('Sent code to Desktop-PC')).toBeNull()
  })

  it('prepends live events from onEvent and caps at 500', async () => {
    const mock = renderFeed()
    await screen.findByText('Received task from MacBook')
    act(() => {
      mock.emitEvent(fixtures.event({ id: 'live-1', type: 'task_received', peer: 'Linux-Box' }))
    })
    const items = within(screen.getByRole('list', { name: 'Activity' })).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('Received task from Linux-Box')

    act(() => {
      for (let i = 0; i < 600; i++)
        mock.emitEvent(fixtures.event({ id: `bulk-${i}`, type: 'node_online', peer: `n${i}`, ts: new Date(Date.now() + i).toISOString() }))
    })
    await waitFor(() =>
      expect(within(screen.getByRole('list', { name: 'Activity' })).getAllByRole('listitem')).toHaveLength(500)
    )
  })

  it('phrases every event type for humans', () => {
    const e = (type: Parameters<typeof fixtures.event>[0]['type'], extra = {}) =>
      eventSentence(fixtures.event({ type, peer: 'MacBook', ...extra }))
    expect(e('task_sent', { summary: 'Task sent' })).toBe('Sent a task to MacBook')
    expect(e('node_online')).toBe('MacBook came online')
    expect(e('node_offline')).toBe('MacBook went offline')
    expect(e('inbox_degraded')).toBe('This computer can’t receive tasks right now')
    expect(relativeTime(new Date(Date.now() - 3 * 3600_000).toISOString())).toBe('3 hours ago')
  })
})
