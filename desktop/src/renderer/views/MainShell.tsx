import { useCallback, useEffect, useRef, useState } from 'react'
import type { AirEvent, AuthState, AuthUser, BackendLifecycle } from '../../shared/types'
import { InfoIcon } from '../components/Icons'
import { SendTaskSheet } from '../components/SendTaskSheet'
import { Sidebar, type ViewId } from '../components/Sidebar'
import type { DotStatus } from '../components/StatusDot'
import { useToast } from '../components/Toast'
import { api } from '../lib/api'
import { eventSentence } from '../lib/format'
import { useBackendStatus, useEvents, useNodes } from '../lib/hooks'
import { useNetworkStatus } from '../lib/network'
import { SYSTEM_NETWORK_HINT, type LicenseView, type NetMode } from '../lib/preview'
import { ActivityFeed } from './ActivityFeed'
import { PlansPage } from './Paywall'
import { Settings } from './Settings'
import { SwarmMap } from './SwarmMap'

const ACTIVE_LINK_MS = 4000

/** Present only in preview (license not enforced, PHASE3_PLAN.md §8). */
export interface PreviewInfo {
  auth: AuthState
  netMode: NetMode
  onRecheck: () => Promise<boolean>
}

export function MainShell({
  user,
  license,
  lifecycle,
  initialView = 'swarm',
  preview
}: {
  user?: AuthUser
  license: LicenseView | null
  lifecycle: BackendLifecycle | null
  initialView?: ViewId
  preview?: PreviewInfo
}) {
  const [view, setViewRaw] = useState<ViewId>(initialView)
  // Preview only: Settings → Account → Plans, shown in place of Settings.
  const [plans, setPlans] = useState(false)
  const setView = useCallback((v: ViewId) => {
    setPlans(false)
    setViewRaw(v)
  }, [])
  const systemNet = preview?.netMode === 'system'
  const [sheet, setSheet] = useState<{ open: boolean; target?: string | null }>({ open: false })
  const [unseen, setUnseen] = useState(0)
  const [activePeers, setActivePeers] = useState<ReadonlySet<string>>(new Set())
  const viewRef = useRef(view)
  viewRef.current = view
  const toast = useToast()

  const nodes = useNodes()
  const status = useBackendStatus()
  const network = useNetworkStatus()

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
  }, [setView])

  // Move focus to the new page heading for screen-reader + keyboard users.
  const mainRef = useRef<HTMLElement>(null)
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    mainRef.current?.querySelector<HTMLElement>('h1')?.focus()
  }, [view, plans])

  const online = nodes.data ? nodes.data.nodes.filter((n) => n.online).length : null
  // The footer always shows the private network; the background service only
  // speaks up when something needs attention.
  const service: { status: DotStatus; label: string } | null =
    status && !status.inbox.listening
      ? { status: 'warning', label: 'Can’t receive tasks' }
      : network.available && !systemNet
        ? null
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
        // On the computer's existing network there's no network of ours to report.
        network={network.available && !systemNet ? network : undefined}
        preview={preview ? { auth: preview.auth } : undefined}
      />
      <main
        id="content"
        ref={mainRef}
        className="min-w-0 flex-1 overflow-y-auto [&_h1]:outline-none"
        aria-label={plans ? 'Plans' : view === 'swarm' ? 'Devices' : view === 'activity' ? 'Activity' : 'Settings'}
      >
        <div className="mx-auto w-full max-w-[1160px] px-8 pb-10">
          {license?.state === 'grace' && !preview ? (
            <div role="status" className="mt-6 flex items-center gap-3 rounded-xl border border-warn/25 bg-warn/10 px-4 py-2.5 text-[13px] text-ink">
              <InfoIcon size={16} className="shrink-0 text-warn" />
              You’re offline. AirBridge keeps working
              {license.exp ? ` until ${new Date(license.exp * 1000).toLocaleDateString()}` : ''} and will re-check your
              subscription when you’re back online.
            </div>
          ) : null}
          {plans && preview ? (
            <PlansPage onBack={() => setPlans(false)} onRecheck={preview.onRecheck} />
          ) : view === 'swarm' ? (
            <SwarmMap
              data={nodes.data}
              loading={nodes.loading}
              ipcError={nodes.error}
              platform={api().app.platform}
              onRetry={() => void nodes.refresh()}
              onSendTask={(target) => setSheet({ open: true, target })}
              activePeers={activePeers}
              networkHint={systemNet ? SYSTEM_NETWORK_HINT : undefined}
            />
          ) : view === 'activity' ? (
            <ActivityFeed events={feed.events} loading={feed.loading} freshIds={feed.freshIds} />
          ) : (
            <Settings
              user={user}
              license={license}
              lifecycle={lifecycle}
              status={status}
              network={network}
              preview={
                preview
                  ? {
                      auth: preview.auth,
                      netMode: preview.netMode,
                      devicesProblem: !!nodes.data?.error,
                      onOpenPlans: () => setPlans(true)
                    }
                  : undefined
              }
            />
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
