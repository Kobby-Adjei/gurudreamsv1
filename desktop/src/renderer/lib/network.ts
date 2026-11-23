import { useCallback, useEffect, useRef, useState } from 'react'
import type { Unsubscribe } from '../../shared/types'
import type { DotStatus } from '../components/StatusDot'
import { api } from './api'

/**
 * The app's own private network (PHASE3_PLAN.md §2, `window.airbridge.network`).
 * Mirrors `NetStatus` in shared/types.ts; declared here too so the renderer
 * keeps compiling against an older preload that doesn't expose it yet.
 */
export type NetState = 'stopped' | 'starting' | 'needs_login' | 'connecting' | 'connected' | 'error'

export interface NetStatus {
  state: NetState
  detail?: string
  ip?: string
}

export interface NetworkBridge {
  getStatus(): Promise<NetStatus>
  onChange(cb: (status: NetStatus) => void): Unsubscribe
  /** Optional: ask main to try again right away (falls back to re-reading status). */
  retry?(): Promise<unknown>
}

/** The network bridge, or null when this preload predates it. */
export function networkBridge(): NetworkBridge | null {
  try {
    const n = (api() as unknown as { network?: NetworkBridge }).network
    return n && typeof n.getStatus === 'function' ? n : null
  } catch {
    return null
  }
}

export type NetPhase = 'connected' | 'connecting' | 'off' | 'error'

/** Collapse the daemon's states into the four things a person needs to know. */
export function netPhase(s: NetStatus | null | undefined): NetPhase {
  switch (s?.state) {
    case 'connected':
      return 'connected'
    case 'error':
      return 'error'
    case 'stopped':
      return 'off'
    default:
      // starting / needs_login (enrolment in progress) / connecting / not known yet
      return 'connecting'
  }
}

export const NET_COPY: Record<NetPhase, { dot: DotStatus; label: string }> = {
  connected: { dot: 'online', label: 'Connected' },
  connecting: { dot: 'starting', label: 'Connecting…' },
  off: { dot: 'offline', label: 'Off' },
  error: { dot: 'error', label: 'Couldn’t connect' }
}

export interface NetworkState {
  /** null until the first answer arrives (or forever, without a network bridge). */
  status: NetStatus | null
  /** false when the preload has no `network` surface at all. */
  available: boolean
  retrying: boolean
  retry: () => Promise<void>
}

export function useNetworkStatus(): NetworkState {
  const [status, setStatus] = useState<NetStatus | null>(null)
  const [retrying, setRetrying] = useState(false)
  const alive = useRef(true)
  const bridge = networkBridge()
  const available = bridge !== null

  useEffect(() => {
    alive.current = true
    const n = networkBridge()
    if (!n) return
    n.getStatus()
      .then((s) => alive.current && setStatus(s))
      .catch(() => undefined)
    const off = n.onChange((s) => alive.current && setStatus(s))
    return () => {
      alive.current = false
      off()
    }
  }, [])

  const retry = useCallback(async () => {
    const n = networkBridge()
    if (!n) return
    setRetrying(true)
    try {
      if (typeof n.retry === 'function') await n.retry()
      const s = await n.getStatus()
      if (alive.current) setStatus(s)
    } catch {
      /* the status line keeps saying what's wrong */
    } finally {
      if (alive.current) setRetrying(false)
    }
  }, [])

  return { status, available, retrying, retry }
}
