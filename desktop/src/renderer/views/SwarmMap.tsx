import { useMemo, useState } from 'react'
import type { Node, NodesResponse } from '../../shared/types'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { DeviceGlyph } from '../components/DeviceGlyph'
import { EmptyState } from '../components/EmptyState'
import { PlusIcon, RefreshIcon, SendIcon, WifiOffIcon } from '../components/Icons'
import { PageHeader } from '../components/PageHeader'
import { SignInPrompt } from '../components/SignInPrompt'
import { Skeleton } from '../components/Skeleton'
import { StatusDot } from '../components/StatusDot'
import { useMediaQuery, useNow } from '../lib/hooks'
import { osLabel, relativeTime, thisComputerLabel } from '../lib/format'

const MAX_RADIAL = 10

type Layout = 'map' | 'list'

export interface SwarmMapProps {
  data: NodesResponse | null
  loading: boolean
  ipcError?: string | null
  platform: string
  onRetry: () => void
  onSendTask: (target?: string) => void
  /** Peers with traffic in the last few seconds – their link glows. */
  activePeers?: ReadonlySet<string>
  /** Preview, signed out: the private network waits for a sign-in, so ask for it here. */
  signIn?: { signingIn: boolean }
}

/** Evenly spread peers around an ellipse; a pleasing start angle per count. */
export function radialPositions(count: number): { x: number; y: number }[] {
  if (count === 0) return []
  const start = count <= 2 ? 0 : count === 4 ? -45 : -90
  const rx = count <= 2 ? 32 : 36
  const ry = 34
  return Array.from({ length: count }, (_, i) => {
    const a = ((start + (360 / count) * i) * Math.PI) / 180
    return { x: 50 + rx * Math.cos(a), y: 50 + ry * Math.sin(a) }
  })
}

function sortPeers(nodes: Node[]): Node[] {
  return [...nodes].sort(
    (a, b) => Number(b.online) - Number(a.online) || a.hostname.localeCompare(b.hostname)
  )
}

export function SwarmMap({ data, loading, ipcError, platform, onRetry, onSendTask, activePeers, signIn }: SwarmMapProps) {
  const wide = useMediaQuery('(min-width: 900px)', true)
  const [layout, setLayout] = useState<Layout>('map')
  useNow(30_000)

  const peers = useMemo(() => sortPeers(data?.nodes ?? []), [data])
  const online = peers.filter((n) => n.online).length
  const networkProblem = !!data?.error && peers.length === 0
  const radial = layout === 'map' && wide && peers.length <= MAX_RADIAL

  const subtitle = signIn
    ? 'Not connected yet'
    : loading && !data
    ? 'Looking for your devices…'
    : peers.length === 0
      ? 'Only this computer so far'
      : `${online} of ${peers.length} online`

  return (
    <>
      <PageHeader
        title="Your devices"
        subtitle={subtitle}
        actions={
          signIn ? null : (
            <>
              {peers.length > 0 && wide && peers.length <= MAX_RADIAL ? (
                <div role="group" aria-label="Layout" className="flex rounded-xl border border-line/[0.08] bg-surface-1 p-0.5">
                  {(['map', 'list'] as const).map((l) => (
                    <button
                      key={l}
                      type="button"
                      aria-pressed={layout === l}
                      onClick={() => setLayout(l)}
                      className={`h-8 rounded-[10px] px-3 text-[13px] font-medium transition ${
                        layout === l ? 'bg-surface-3 text-ink' : 'text-ink-muted hover:text-ink'
                      }`}
                    >
                      {l === 'map' ? 'Map' : 'List'}
                    </button>
                  ))}
                </div>
              ) : null}
              {peers.length > 0 ? (
                <Button variant="primary" icon={<SendIcon size={16} />} onClick={() => onSendTask()} disabled={online === 0}>
                  Send a task
                </Button>
              ) : null}
            </>
          )
        }
      />

      {signIn ? (
        <SignInPrompt signingIn={signIn.signingIn} />
      ) : loading && !data ? (
        <MapSkeleton />
      ) : ipcError && !data ? (
        <Card>
          <EmptyState
            tone="warn"
            icon={<WifiOffIcon size={26} />}
            title="Can’t reach the AirBridge service"
            action={
              <Button variant="primary" icon={<RefreshIcon size={16} />} onClick={onRetry}>
                Retry
              </Button>
            }
          >
            It may still be starting up. Give it a moment, then retry.
          </EmptyState>
        </Card>
      ) : networkProblem ? (
        <Card>
          <EmptyState
            tone="warn"
            icon={<WifiOffIcon size={26} />}
            title="Can’t see your other devices right now"
            action={
              <Button variant="primary" icon={<RefreshIcon size={16} />} onClick={onRetry}>
                Retry
              </Button>
            }
          >
            <p>Your private network is still connecting.</p>
            <p className="mt-1 font-medium text-ink">Check that this computer is online, then press Retry.</p>
          </EmptyState>
        </Card>
      ) : peers.length === 0 ? (
        <EmptyDevices self={data?.self} platform={platform} />
      ) : radial ? (
        <RadialMap self={data?.self} platform={platform} peers={peers} onSendTask={onSendTask} activePeers={activePeers} />
      ) : (
        <GridMap self={data?.self} platform={platform} peers={peers} onSendTask={onSendTask} />
      )}
    </>
  )
}

function SelfCard({ self, platform, compact = false }: { self?: NodesResponse['self']; platform: string; compact?: boolean }) {
  return (
    <div
      className={`relative flex rounded-2xl border border-line/15 bg-surface-2 ${
        compact ? 'w-full flex-row items-center gap-3 p-4 text-left' : 'w-[200px] shrink-0 flex-col items-center px-5 pb-5 pt-6 text-center'
      }`}
    >
      <DeviceGlyph
        os={self?.os ?? platform}
        hostname={self?.hostname}
        size={compact ? 20 : 24}
        className={compact ? 'h-10 w-10 rounded-xl' : 'h-12 w-12 rounded-2xl'}
      />
      <div className={compact ? 'min-w-0 flex-1' : 'mt-3 min-w-0'}>
        <p className="text-[12px] font-medium text-ink-faint">{thisComputerLabel(platform)}</p>
        <p className="mt-0.5 truncate text-[15px] font-semibold text-ink selectable">{self?.hostname ?? '—'}</p>
      </div>
    </div>
  )
}

function PeerCard({ node, onSendTask, className = '' }: { node: Node; onSendTask: (t?: string) => void; className?: string }) {
  const os = node.os ? osLabel(node.os) : null
  const body = (
    <>
      <DeviceGlyph os={node.os} hostname={node.hostname} size={20} tone={node.online ? 'neutral' : 'muted'} className="h-10 w-10 rounded-xl" />
      <span className="min-w-0 flex-1 text-left">
        <span className={`block truncate text-[14px] font-semibold ${node.online ? 'text-ink' : 'text-ink-muted'}`}>
          {node.hostname}
        </span>
        {os ? <span className="block truncate text-[12px] text-ink-faint">{os}</span> : null}
        <span className="mt-1.5 block">
          {node.online ? (
            <StatusDot status="online" />
          ) : (
            <>
              <StatusDot status="offline" />
              {node.last_seen ? (
                <span className="mt-0.5 block truncate text-[11.5px] text-ink-faint">
                  Last seen {relativeTime(node.last_seen)}
                </span>
              ) : null}
            </>
          )}
        </span>
      </span>
    </>
  )
  const cls = `flex w-[208px] items-start gap-3 rounded-2xl border p-3.5 transition-colors duration-150 ${className}`
  if (!node.online) {
    return (
      <div className={`${cls} border-line/[0.06] bg-surface-1`} data-testid="peer-card">
        {body}
      </div>
    )
  }
  return (
    <button
      type="button"
      data-testid="peer-card"
      onClick={() => onSendTask(node.hostname)}
      aria-label={`${node.hostname}${os ? `, ${os}` : ''}, online. Send a task`}
      className={`${cls} border-line/10 bg-surface-1 hover:border-line/25 hover:bg-surface-2`}
    >
      {body}
    </button>
  )
}

function RadialMap({
  self,
  platform,
  peers,
  onSendTask,
  activePeers
}: {
  self?: NodesResponse['self']
  platform: string
  peers: Node[]
  onSendTask: (t?: string) => void
  activePeers?: ReadonlySet<string>
}) {
  const pos = radialPositions(peers.length)
  return (
    <section
      aria-label="Device map"
      className="map-backdrop relative h-[clamp(460px,calc(100vh-190px),680px)] overflow-hidden rounded-2xl border border-line/[0.06] bg-surface-1/40"
    >
      <svg
        className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {peers.map((n, i) => {
          const { x, y } = pos[i]
          const active = activePeers?.has(n.hostname)
          // 1px static hairlines in neutral grey; online a little brighter.
          // A task briefly brightens the line (one short fade, never looping).
          return (
            <path
              key={n.hostname}
              d={`M50 50 L${x.toFixed(2)} ${y.toFixed(2)}`}
              stroke="rgb(var(--line))"
              strokeOpacity={active ? 0.45 : n.online ? 0.22 : 0.09}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              fill="none"
              data-link={n.online ? 'online' : 'offline'}
              className="transition-[stroke-opacity] duration-500 ease-out"
            />
          )
        })}
      </svg>

      <div className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
        <SelfCard self={self} platform={platform} />
      </div>

      <ul aria-label="Other computers" className="pointer-events-none absolute inset-0 z-10">
        {peers.map((n, i) => (
          <li
            key={n.hostname}
            className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${pos[i].x}%`, top: `${pos[i].y}%` }}
          >
            <PeerCard node={n} onSendTask={onSendTask} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function GridMap({
  self,
  platform,
  peers,
  onSendTask
}: {
  self?: NodesResponse['self']
  platform: string
  peers: Node[]
  onSendTask: (t?: string) => void
}) {
  return (
    <section aria-label="Device list" className="space-y-4">
      <SelfCard self={self} platform={platform} compact />
      <ul aria-label="Other computers" className="grid grid-cols-[repeat(auto-fill,minmax(208px,1fr))] gap-3">
        {peers.map((n) => (
          <li key={n.hostname} className="[&>*]:w-full">
            <PeerCard node={n} onSendTask={onSendTask} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function EmptyDevices({ self, platform }: { self?: NodesResponse['self']; platform: string }) {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="map-backdrop relative flex min-h-[320px] items-center justify-center gap-6 overflow-hidden rounded-2xl border border-line/[0.06] bg-surface-1/40 p-8">
        <SelfCard self={self} platform={platform} />
        <svg width="56" height="8" viewBox="0 0 56 8" aria-hidden="true" className="hidden shrink-0 text-line/30 2xl:block">
          <path d="M0 4h56" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 5" />
        </svg>
        <div
          aria-hidden="true"
          className="hidden h-[148px] w-[160px] shrink-0 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line/20 text-ink-faint 2xl:flex"
        >
          <PlusIcon size={22} />
          <span className="text-[12px] font-medium">Your next computer</span>
        </div>
      </div>
      <Card className="flex flex-col justify-center">
        <h2 className="text-[17px] font-semibold tracking-tightish">Just this computer so far</h2>
        <p className="mt-2 text-[14px] leading-6 text-ink-muted">
          Sign in to AirBridge on your other computer and it will appear here.
        </p>
        <ol className="mt-5 space-y-3">
          {[
            ['Install AirBridge on your other computer', 'The same app you’re using now, on Mac, Windows or Linux.'],
            ['Sign in with the same account', 'It connects privately and shows up here by itself.']
          ].map(([title, body], i) => (
            <li key={title} className="flex gap-3">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-line/15 text-[12px] font-medium text-ink-muted">
                {i + 1}
              </span>
              <span>
                <span className="block text-[14px] font-medium text-ink">{title}</span>
                <span className="block text-[13px] text-ink-muted">{body}</span>
              </span>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  )
}

function MapSkeleton() {
  return (
    <div role="status" className="map-backdrop relative h-[460px] rounded-2xl border border-line/[0.06] bg-surface-1/40">
      <span className="sr-only">Looking for your devices…</span>
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <Skeleton className="h-[148px] w-[200px] rounded-2xl" />
      </div>
      {radialPositions(4).map((p, i) => (
        <div key={i} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${p.x}%`, top: `${p.y}%` }}>
          <Skeleton className="h-[84px] w-[208px] rounded-2xl" />
        </div>
      ))}
    </div>
  )
}
