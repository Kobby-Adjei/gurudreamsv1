import { useCallback, useEffect, useRef, useState } from 'react'
import type { AirEvent, AuthUser, BackendLifecycle, LicenseStatus } from '../../shared/types'
import { InfoIcon } from '../components/Icons'
import { SendTaskSheet } from '../components/SendTaskSheet'
import { Sidebar, type ViewId } from '../components/Sidebar'
import type { DotStatus } from '../components/StatusDot'
import { useToast } from '../components/Toast'
import { api } from '../lib/api'
import { eventSentence } from '../lib/format'
import { useBackendStatus, useEvents, useNodes } from '../lib/hooks'
import { ActivityFeed } from './ActivityFeed'
import { Settings } from './Settings'
import { SwarmMap } from './SwarmMap'

const ACTIVE_LINK_MS = 4000

export function MainShell({
  user,
  license,
  lifecycle,
  initialView = 'swarm'
}: {
  user?: AuthUser
  license: LicenseStatus | null
  lifecycle: BackendLifecycle | null
  initialView?: ViewId
}) {
  const [view, setView] = useState<ViewId>(initialView)
  const [sheet, setSheet] = useState<{ open: boolean; target?: string | null }>({ open: false })
  const [unseen, setUnseen] = useState(0)
  const [activePeers, setActivePeers] = useState<ReadonlySet<string>>(new Set())
  const viewRef = useRef(view)
  viewRef.current = view
  const toast = useToast()

  const nodes = useNodes()
  const status = useBackendStatus()

  const onLive = useCallback(
    (e: AirEvent) => {
      if (e.type === 'node_online' || e.type === 'node_offline') void nodes.refresh()
      if (viewRef.current !== 'activity') setUnseen((n) => n + 1)
      if (e.type === 'task_received' && viewRef.current !== 'activity')
        toast.show({ tone: 'info', title: eventSentence(e), body: 'Your AI app can pick it up from the inbox.' })
      if (e.peer && (e.type === 'task_sent' || e.type === 'task_received')) {
        const peer = e.peer
        setActivePeers((s) => new Set(s).add(peer))
        window.setTimeout(
          () =>
            setActivePeers((s) => {
              const n = new Set(s)
              n.delete(peer)
              return n
            }),
          ACTIVE_LINK_MS
        )
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes.refresh, toast]
  )
  const feed = useEvents(onLive)

  useEffect(() => {
    if (view === 'activity') setUnseen(0)
  }, [view])

  // ⌘/Ctrl + 1/2/3 switch views; ⌘/Ctrl + N opens "Send a task".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      const map: Record<string, ViewId> = { '1': 'swarm', '2': 'activity', '3': 'settings' }
      if (map[e.key]) {
        e.preventDefault()
        setView(map[e.key])
      } else if (e.key.toLowerCase() === 'n') {
        e.preventDefault()
        setSheet({ open: true })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Move focus to the new page heading for screen-reader + keyboard users.
  const mainRef = useRef<HTMLElement>(null)
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    mainRef.current?.querySelector<HTMLElement>('h1')?.focus()
  }, [view])

  const online = nodes.data ? nodes.data.nodes.filter((n) => n.online).length : null
  const service: { status: DotStatus; label: string } =
    status && !status.inbox.listening
      ? { status: 'warning', label: 'Can’t receive tasks' }
      : nodes.data?.error
        ? { status: 'warning', label: 'Tailscale not connected' }
        : { status: 'online', label: 'AirBridge is running' }

  return (
    <div className="flex h-full bg-canvas">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-xl focus:bg-accent focus:px-4 focus:py-2 focus:text-accent-fg"
      >
        Skip to content
      </a>
      <Sidebar
        current={view}
        onNavigate={setView}
        user={user}
        license={license}
        onlineCount={online}
        unseenActivity={unseen}
        service={service}
      />
      <main
        id="content"
        ref={mainRef}
        className="min-w-0 flex-1 overflow-y-auto [&_h1]:outline-none"
        aria-label={view === 'swarm' ? 'Swarm' : view === 'activity' ? 'Activity' : 'Settings'}
      >
        <div className="mx-auto w-full max-w-[1160px] px-8 pb-10">
          {license?.state === 'grace' ? (
            <div role="status" className="mt-6 flex items-center gap-3 rounded-xl border border-warn/25 bg-warn/10 px-4 py-2.5 text-[13px] text-ink">
              <InfoIcon size={16} className="shrink-0 text-warn" />
              You’re offline. AirBridge keeps working
              {license.exp ? ` until ${new Date(license.exp * 1000).toLocaleDateString()}` : ''} and will re-check your
              subscription when you’re back online.
            </div>
          ) : null}
          {view === 'swarm' ? (
            <SwarmMap
              data={nodes.data}
              loading={nodes.loading}
              ipcError={nodes.error}
              platform={api().app.platform}
              onRetry={() => void nodes.refresh()}
              onSendTask={(target) => setSheet({ open: true, target })}
              activePeers={activePeers}
            />
          ) : view === 'activity' ? (
            <ActivityFeed events={feed.events} loading={feed.loading} freshIds={feed.freshIds} />
          ) : (
            <Settings user={user} license={license} lifecycle={lifecycle} status={status} />
          )}
        </div>
      </main>
      <SendTaskSheet
        open={sheet.open}
        initialTarget={sheet.target}
        nodes={nodes.data?.nodes ?? []}
        onClose={() => setSheet({ open: false })}
      />
    </div>
  )
}
