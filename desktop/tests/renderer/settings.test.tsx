import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CopyButton } from '../../src/renderer/components/CopyButton'
import { PrivateNetworkCard } from '../../src/renderer/components/PrivateNetworkCard'
import { Settings } from '../../src/renderer/views/Settings'
import { ToastProvider } from '../../src/renderer/components/Toast'
import type { NetStatus, NetworkState } from '../../src/renderer/lib/network'
import { fixtures, installMockApi } from './setup'

const net = (status: NetStatus | null, retry = vi.fn(async () => undefined)): NetworkState => ({
  status,
  available: true,
  retrying: false,
  retry
})

function renderSettings() {
  const mock = installMockApi()
  render(
    <ToastProvider>
      <Settings
        user={fixtures.user}
        license={mock.state.license}
        lifecycle={{ phase: 'running' }}
        status={fixtures.status()}
        network={net({ state: 'connected', ip: '100.64.0.1' })}
      />
    </ToastProvider>
  )
  return mock
}

describe('Settings', () => {
  it('Copy button calls settings.copyMcpConfig and confirms with Copied', async () => {
    const mock = renderSettings()
    expect(await screen.findByText(/"mcpServers"/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Copy setup code' }))
    expect(mock.api.settings.copyMcpConfig).toHaveBeenCalledWith('claude')
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    expect(screen.getByText('Copied to clipboard')).toBeInTheDocument()
  })

  it('switches to Cursor with the keyboard and copies the Cursor config', async () => {
    const mock = renderSettings()
    const claudeTab = screen.getByRole('tab', { name: 'Claude Desktop' })
    expect(claudeTab).toHaveAttribute('aria-selected', 'true')
    claudeTab.focus()
    await userEvent.keyboard('{ArrowRight}')
    const cursorTab = screen.getByRole('tab', { name: 'Cursor' })
    expect(cursorTab).toHaveAttribute('aria-selected', 'true')
    expect(cursorTab).toHaveFocus()
    await waitFor(() => expect(mock.api.settings.getMcpConfig).toHaveBeenCalledWith('cursor'))
    expect(screen.getByText('Restart Cursor')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Copy setup code' }))
    expect(mock.api.settings.copyMcpConfig).toHaveBeenCalledWith('cursor')
  })

  it('shows account, plan and opens checkout from Manage subscription', async () => {
    const mock = renderSettings()
    expect(screen.getByText('grace@example.com')).toBeInTheDocument()
    expect(screen.getByText(/^AirBridge Pro\s*$/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Manage subscription/ }))
    expect(mock.api.license.openCheckout).toHaveBeenCalledOnce()
    expect(screen.getByText('Yes, on port 8989')).toBeInTheDocument()
    expect(screen.getByText(/AirBridge Pro 0\.2\.0 · macOS/)).toBeInTheDocument()
  })

  it('shows the private network in plain words, with the address only under Details', async () => {
    renderSettings()
    const card = screen.getByRole('region', { name: 'Private network' })
    expect(card).toHaveTextContent('Connected')
    expect(card).toHaveTextContent(/signed in to the same account appear automatically/)
    const ip = screen.getByText('100.64.0.1')
    expect(ip).not.toBeVisible()
    await userEvent.click(screen.getByText('Details'))
    expect(ip).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.queryByText(/port 8989/)).toBeInTheDocument()
  })

  it('PrivateNetworkCard: Connecting…, then Couldn’t connect with one Retry', async () => {
    const retry = vi.fn(async () => undefined)
    const { rerender } = render(<PrivateNetworkCard network={net({ state: 'needs_login' }, retry)} />)
    expect(screen.getByText('Connecting…')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText('Details')).toBeNull()

    rerender(<PrivateNetworkCard network={net({ state: 'error', detail: 'gave up after 5 tries' }, retry)} />)
    expect(screen.getByText('Couldn’t connect')).toBeInTheDocument()
    expect(screen.getByTestId('status-dot-error')).toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledOnce()
    expect(screen.getByText('gave up after 5 tries')).not.toBeVisible()
  })

  it('CopyButton shows a retry label when copying fails', async () => {
    const onCopy = vi.fn(async () => {
      throw new Error('nope')
    })
    render(<CopyButton onCopy={onCopy} label="Copy" />)
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})
