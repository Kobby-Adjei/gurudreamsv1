/**
 * Renderer test setup: jest-dom matchers, a deterministic matchMedia, and a
 * fully mocked `window.airbridge` (the frozen preload surface).
 */
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import type {
  AirEvent,
  AirbridgeApi,
  AuthState,
  BackendLifecycle,
  BackendStatus,
  LicenseStatus,
  NodesResponse
} from '../../src/shared/types'
import type { NetworkBridge, NetStatus } from '../../src/renderer/lib/network'

const isDom = typeof window !== 'undefined'

const ago = (sec: number) => new Date(Date.now() - sec * 1000).toISOString()

export const fixtures = {
  user: { id: 'user_123', email: 'grace@example.com', name: 'Grace Hopper' },
  nodes(): NodesResponse {
    return {
      self: { hostname: 'Studio-Air', ip: '100.64.0.1', os: 'macOS' },
      nodes: [
        { hostname: 'MacBook', ip: '100.64.0.2', os: 'macOS', online: true, last_seen: null },
        { hostname: 'Desktop-PC', ip: '100.64.0.3', os: 'windows', online: true, last_seen: null },
        { hostname: 'Studio-Mac', ip: '100.64.0.4', os: 'macOS', online: false, last_seen: ago(7200) }
      ],
      error: null
    }
  },
  status(): BackendStatus {
    return {
      version: '0.2.0',
      mode: 'daemon',
      tailnet_ip: '100.64.0.1',
      inbox: { listening: true, port: 8989, degraded_reason: null },
      uptime_s: 3720
    }
  },
  event(partial: Partial<AirEvent> & Pick<AirEvent, 'type'>): AirEvent {
    return {
      v: 1,
      id: partial.id ?? Math.random().toString(36).slice(2),
      ts: partial.ts ?? new Date().toISOString(),
      origin: 'daemon',
      local_node: 'Studio-Air',
      peer: null,
      summary: '',
      detail: {},
      ...partial
    }
  },
  events(): AirEvent[] {
    return [
      fixtures.event({ id: 'e1', type: 'task_received', peer: 'MacBook', ts: ago(30), summary: 'Task received', detail: { bytes: 2048, file: 'task_20261123-120000-000001.md' } }),
      fixtures.event({ id: 'e2', type: 'task_sent', peer: 'Desktop-PC', ts: ago(300), origin: 'mcp', summary: 'Task with code sent', detail: { bytes: 9000 } }),
      fixtures.event({ id: 'e3', type: 'send_failed', peer: 'Studio-Mac', ts: ago(3600), summary: 'Send failed', detail: { error: 'connect timeout' } })
    ]
  }
}

export interface MockState {
  auth: AuthState
  license: LicenseStatus
  lifecycle: BackendLifecycle
  nodes: NodesResponse | null
  status: BackendStatus | null
  events: AirEvent[]
  network: NetStatus
}

/** The bridge plus `network` (Phase 3), whether or not shared/types.ts declares it yet. */
export type MockApi = AirbridgeApi & { network: NetworkBridge }

export interface MockHandle {
  api: MockApi
  state: MockState
  emitEvent: (e: AirEvent) => void
  emitLifecycle: (l: BackendLifecycle) => void
  emitAuth: (a: AuthState) => void
  emitLicense: (l: LicenseStatus) => void
  emitNetwork: (n: NetStatus) => void
}

export function defaultState(): MockState {
  return {
    auth: { state: 'signed_in', user: fixtures.user },
    license: { state: 'valid', plan: 'airbridge_pro', exp: Math.floor(Date.now() / 1000) + 72 * 3600, enforced: true },
    lifecycle: { phase: 'running' },
    nodes: fixtures.nodes(),
    status: fixtures.status(),
    events: fixtures.events(),
    network: { state: 'connected', ip: '100.64.0.1' }
  }
}

/** Install a fresh mocked bridge; tests tweak `state` before rendering. */
export function installMockApi(overrides: Partial<MockState> = {}): MockHandle {
  const state: MockState = { ...defaultState(), ...overrides }
  const listeners = {
    event: new Set<(e: AirEvent) => void>(),
    status: new Set<(s: BackendStatus) => void>(),
    lifecycle: new Set<(l: BackendLifecycle) => void>(),
    auth: new Set<(a: AuthState) => void>(),
    license: new Set<(l: LicenseStatus) => void>(),
    network: new Set<(n: NetStatus) => void>()
  }
  const sub = <T,>(set: Set<T>) => (cb: T) => {
    set.add(cb)
    return () => set.delete(cb)
  }
  const api: MockApi = {
    auth: {
      getState: vi.fn(async () => state.auth),
      signIn: vi.fn(async () => undefined),
      signOut: vi.fn(async () => undefined),
      onChange: vi.fn(sub(listeners.auth))
    },
    license: {
      getStatus: vi.fn(async () => state.license),
      refresh: vi.fn(async () => state.license),
      openCheckout: vi.fn(async () => undefined),
      onChange: vi.fn(sub(listeners.license))
    } as AirbridgeApi['license'],
    backend: {
      getStatus: vi.fn(async () => state.status),
      getLifecycle: vi.fn(async () => state.lifecycle),
      getNodes: vi.fn(async () => state.nodes),
      getEvents: vi.fn(async (limit: number) => state.events.slice(0, limit)),
      sendTask: vi.fn(async (req) => ({ ok: true as const, file: 'task.md', target: req.target_hostname })),
      onEvent: vi.fn(sub(listeners.event)),
      onStatus: vi.fn(sub(listeners.status)),
      onLifecycle: vi.fn(sub(listeners.lifecycle))
    },
    settings: {
      getMcpConfig: vi.fn(async (client) => ({
        json: JSON.stringify(
          { mcpServers: { airbridge: { command: '/Applications/AirBridge Pro.app/Contents/Resources/bin/airbridge-core', args: [], env: { CLIENT: client } } } },
          null,
          2
        )
      })),
      copyMcpConfig: vi.fn(async () => undefined)
    },
    network: {
      getStatus: vi.fn(async () => state.network),
      retry: vi.fn(async () => state.network),
      onChange: vi.fn(sub(listeners.network))
    },
    app: { version: '0.2.0', platform: 'darwin' }
  }
  ;(window as unknown as { airbridge: AirbridgeApi }).airbridge = api
  return {
    api,
    state,
    emitEvent: (e) => listeners.event.forEach((cb) => cb(e)),
    emitLifecycle: (l) => {
      state.lifecycle = l
      listeners.lifecycle.forEach((cb) => cb(l))
    },
    emitLicense: (l) => {
      state.license = l
      listeners.license.forEach((cb) => cb(l))
    },
    emitNetwork: (n) => {
      state.network = n
      listeners.network.forEach((cb) => cb(n))
    },
    emitAuth: (a) => {
      state.auth = a
      listeners.auth.forEach((cb) => cb(a))
    }
  }
}

if (isDom) {
  // jsdom has no matchMedia: report a wide window, dark scheme, motion allowed.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: /min-width/.test(query) || /prefers-color-scheme:\s*dark/.test(query),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false
    })
  })

  // axe probes <canvas> for icon-font ligatures; jsdom has no canvas backend.
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext']

  if (!navigator.clipboard) {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => undefined }
    })
  }

  beforeEach(() => {
    installMockApi()
  })

  afterEach(() => {
    cleanup()
  })
}
