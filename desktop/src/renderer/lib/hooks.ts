import { useCallback, useEffect, useRef, useState } from 'react'
import type { AirEvent, BackendStatus, NodesResponse } from '../../shared/types'
import { api, errorText } from './api'

export const NODES_POLL_MS = 5000
export const MAX_EVENTS = 500

export function useMediaQuery(query: string, fallback = false): boolean {
  const get = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : fallback
  const [matches, setMatches] = useState(get)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener?.('change', onChange)
    return () => mql.removeEventListener?.('change', onChange)
  }, [query])
  return matches
}

export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)')
}

/** Re-render periodically so relative timestamps stay fresh. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}

export interface NodesState {
  data: NodesResponse | null
  loading: boolean
  /** IPC-level failure (distinct from data.error, which comes from the network itself). */
  error: string | null
  refresh: () => Promise<void>
}

/** Polls getNodes every 5 s; callers may also poke `refresh` on events. */
export function useNodes(pollMs = NODES_POLL_MS): NodesState {
  const [data, setData] = useState<NodesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const res = await api().backend.getNodes()
      if (!alive.current) return
      setData(res)
      setError(null)
    } catch (err) {
      if (alive.current) setError(errorText(err))
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void refresh()
    const id = window.setInterval(() => void refresh(), pollMs)
    return () => {
      alive.current = false
      window.clearInterval(id)
    }
  }, [pollMs, refresh])

  return { data, loading, error, refresh }
}

export interface EventsState {
  events: AirEvent[]
  loading: boolean
  /** ids that arrived live (after first load) – used for the entrance animation. */
  freshIds: ReadonlySet<string>
}

function newestFirst(a: AirEvent, b: AirEvent) {
  return Date.parse(b.ts) - Date.parse(a.ts)
}

/** Loads recent history then appends live events (newest first, capped at 500). */
export function useEvents(onLive?: (e: AirEvent) => void): EventsState {
  const [events, setEvents] = useState<AirEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(new Set())
  const onLiveRef = useRef(onLive)
  onLiveRef.current = onLive

  useEffect(() => {
    let alive = true
    const merge = (incoming: AirEvent[]) =>
      setEvents((prev) => {
        const seen = new Set(prev.map((e) => e.id))
        const add = incoming.filter((e) => e && typeof e.id === 'string' && !seen.has(e.id))
        if (!add.length) return prev
        return [...add, ...prev].sort(newestFirst).slice(0, MAX_EVENTS)
      })

    const unsub = api().backend.onEvent((e) => {
      if (!alive) return
      merge([e])
      setFreshIds((prev) => new Set(prev).add(e.id))
      onLiveRef.current?.(e)
    })

    api()
      .backend.getEvents(MAX_EVENTS)
      .then((list) => {
        if (alive) merge(Array.isArray(list) ? list : [])
      })
      .catch(() => {
        /* history is best-effort; live events still flow */
      })
      .finally(() => {
        if (alive) setLoading(false)
      })

    return () => {
      alive = false
      unsub()
    }
  }, [])

  return { events, loading, freshIds }
}

export function useBackendStatus(): BackendStatus | null {
  const [status, setStatus] = useState<BackendStatus | null>(null)
  useEffect(() => {
    let alive = true
    api()
      .backend.getStatus()
      .then((s) => alive && setStatus(s))
      .catch(() => undefined)
    const unsub = api().backend.onStatus((s) => alive && setStatus(s))
    return () => {
      alive = false
      unsub()
    }
  }, [])
  return status
}
