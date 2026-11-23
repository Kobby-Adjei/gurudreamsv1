import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SwarmMap, radialPositions } from '../../src/renderer/views/SwarmMap'
import { deviceKind } from '../../src/renderer/lib/format'
import { MainShell } from '../../src/renderer/views/MainShell'
import { ToastProvider } from '../../src/renderer/components/Toast'
import { fixtures, installMockApi } from './setup'

const noop = () => undefined

describe('Swarm Map', () => {
  it('shows a green Online indicator (with text) for each online node', () => {
    render(<SwarmMap data={fixtures.nodes()} loading={false} platform="darwin" onRetry={noop} onSendTask={noop} />)

    const map = screen.getByRole('region', { name: 'Device map' })
    const peers = within(map).getByRole('list', { name: 'Other computers' })
    expect(within(peers).getAllByRole('listitem')).toHaveLength(3)

    // Two online peers → two green dots, each paired with the word "Online".
    expect(within(peers).getAllByTestId('status-dot-online')).toHaveLength(2)
    expect(within(peers).getAllByText('Online')).toHaveLength(2)
    expect(within(peers).getAllByTestId('status-dot-offline')).toHaveLength(1)
    expect(within(peers).getByText("Last seen 2 hours ago")).toBeInTheDocument()

    // This computer sits in the middle.
    expect(screen.getByText('This Mac')).toBeInTheDocument()
    expect(screen.getByText('Studio-Air')).toBeInTheDocument()
    expect(screen.getByText('2 of 3 online')).toBeInTheDocument()
  })

  it('opens Send a task pre-targeted when an online device is clicked', async () => {
    const onSendTask = vi.fn()
    render(<SwarmMap data={fixtures.nodes()} loading={false} platform="darwin" onRetry={noop} onSendTask={onSendTask} />)
    await userEvent.click(screen.getByRole('button', { name: /Desktop-PC, Windows PC, online/ }))
    expect(onSendTask).toHaveBeenCalledWith('Desktop-PC')
    // Offline nodes are not actionable.
    expect(screen.queryByRole('button', { name: /Studio-Mac/ })).toBeNull()
  })

  it('says in plain language how to add another computer when there are none', () => {
    const data = { ...fixtures.nodes(), nodes: [] }
    render(<SwarmMap data={data} loading={false} platform="darwin" onRetry={noop} onSendTask={noop} />)
    expect(screen.getByRole('heading', { name: 'Just this computer so far' })).toBeInTheDocument()
    expect(screen.getByText('Sign in to AirBridge on your other computer and it will appear here.')).toBeInTheDocument()
    expect(screen.getByText('Install AirBridge on your other computer')).toBeInTheDocument()
    expect(screen.getByText('Sign in with the same account')).toBeInTheDocument()
    expect(screen.queryByTestId('status-dot-online')).toBeNull()
  })

  it('shows one clear next step when the network can’t list devices', async () => {
    const onRetry = vi.fn()
    const data = { ...fixtures.nodes(), nodes: [], error: 'network: not running' }
    render(<SwarmMap data={data} loading={false} platform="darwin" onRetry={onRetry} onSendTask={noop} />)
    expect(screen.getByRole('heading', { name: 'Can’t see your other devices right now' })).toBeInTheDocument()
    expect(screen.getByText('Check that this computer is online, then press Retry.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('falls back to a list layout', async () => {
    render(<SwarmMap data={fixtures.nodes()} loading={false} platform="win32" onRetry={noop} onSendTask={noop} />)
    await userEvent.click(screen.getByRole('button', { name: 'List' }))
    expect(screen.getByRole('region', { name: 'Device list' })).toBeInTheDocument()
    expect(screen.getByText('This PC')).toBeInTheDocument()
    expect(screen.getAllByText('Online')).toHaveLength(2)
  })

  it('picks a device glyph from hostname hints, then the OS', () => {
    expect(deviceKind('macOS', 'Studio-Mac')).toBe('desktop')
    expect(deviceKind('macOS', 'iMac-Kitchen')).toBe('desktop')
    expect(deviceKind('macOS', 'Mac-mini')).toBe('desktop')
    expect(deviceKind('windows', 'Desktop-PC')).toBe('desktop')
    expect(deviceKind('linux', 'Dev-Workstation')).toBe('desktop')
    expect(deviceKind('macOS', 'MacBook-Pro')).toBe('laptop')
    expect(deviceKind('windows', 'Surface-Laptop')).toBe('laptop')
    expect(deviceKind('macOS', 'graces-mac')).toBe('laptop')
    expect(deviceKind('linux', 'Build-Server')).toBe('server')
    expect(deviceKind('windows', 'GAMING')).toBe('desktop')
    expect(deviceKind('iOS', 'iPhone')).toBe('phone')
    expect(deviceKind('macOS', 'topcat')).toBe('laptop') // "pc" inside a word is not a hint
  })

  it('lets laptop words ("air", "book") beat desktop ones like "studio"', () => {
    expect(deviceKind('macOS', 'Studio-Air')).toBe('laptop')
    expect(deviceKind('macOS', 'StudioAir')).toBe('laptop')
    expect(deviceKind('macOS', 'studio_air')).toBe('laptop')
    expect(deviceKind('macOS', 'MacBook Air')).toBe('laptop')
    expect(deviceKind('macOS', 'Graces-MacBook-Air')).toBe('laptop')
    expect(deviceKind('macOS', 'Air')).toBe('laptop')
    expect(deviceKind('windows', 'Studio-Book')).toBe('laptop')
    expect(deviceKind('windows', 'Studio-Notebook')).toBe('laptop')
    expect(deviceKind(null, 'Studio-Air')).toBe('laptop')
    // …but "air" hidden inside another word is not a hint.
    expect(deviceKind('macOS', 'Claire-iMac')).toBe('desktop')
    expect(deviceKind('windows', 'Repair-Tower')).toBe('desktop')
    expect(deviceKind('macOS', 'Studio')).toBe('desktop')
  })

  it('draws this computer (Studio-Air) as a laptop', () => {
    render(<SwarmMap data={fixtures.nodes()} loading={false} platform="darwin" onRetry={noop} onSendTask={noop} />)
    const self = screen.getByText('Studio-Air').closest('div.relative')!
    expect(self.querySelector('[data-device]')).toHaveAttribute('data-device', 'laptop')
  })

  it('draws Studio-Mac as a desktop on the map', () => {
    render(<SwarmMap data={fixtures.nodes()} loading={false} platform="darwin" onRetry={noop} onSendTask={noop} />)
    const card = screen.getByText('Studio-Mac').closest('[data-testid="peer-card"]')!
    expect(card.querySelector('[data-device]')).toHaveAttribute('data-device', 'desktop')
    const mac = screen.getByText('MacBook').closest('[data-testid="peer-card"]')!
    expect(mac.querySelector('[data-device]')).toHaveAttribute('data-device', 'laptop')
  })

  it('renders gracefully when ip / os are null (network down, OS unknown)', () => {
    const data = {
      self: { hostname: 'Studio-Air', ip: null, os: null },
      nodes: [{ hostname: 'mystery', ip: null, os: null, online: true, last_seen: null }],
      error: null
    }
    render(<SwarmMap data={data} loading={false} platform="darwin" onRetry={noop} onSendTask={noop} />)
    const card = screen.getByRole('button', { name: 'mystery, online. Send a task' })
    expect(card).toHaveTextContent(/^mysteryOnline$/)
    expect(card.querySelector('[data-device]')).toHaveAttribute('data-device', 'desktop')
    expect(screen.queryByText('null')).toBeNull()
    expect(screen.queryByText('Computer')).toBeNull()
    expect(screen.getByText('Studio-Air').parentElement!.querySelector('.font-mono')).toBeNull()
  })

  it('places peers radially around the centre', () => {
    for (const n of [1, 2, 3, 5, 8]) {
      const pts = radialPositions(n)
      expect(pts).toHaveLength(n)
      for (const p of pts) {
        const dist = Math.hypot(p.x - 50, p.y - 50)
        expect(dist).toBeGreaterThan(25)
        expect(p.x).toBeGreaterThan(5)
        expect(p.x).toBeLessThan(95)
      }
    }
  })

  it('polls getNodes every 5 seconds and on node events', async () => {
    vi.useFakeTimers()
    try {
      const mock = installMockApi()
      render(
        <ToastProvider>
          <MainShell user={fixtures.user} license={mock.state.license} lifecycle={{ phase: 'running' }} />
        </ToastProvider>
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10)
      })
      expect(mock.api.backend.getNodes).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(mock.api.backend.getNodes).toHaveBeenCalledTimes(2)
      await act(async () => {
        mock.emitEvent(fixtures.event({ type: 'node_online', peer: 'Studio-Mac' }))
        await vi.advanceTimersByTimeAsync(10)
      })
      expect(mock.api.backend.getNodes).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
})
