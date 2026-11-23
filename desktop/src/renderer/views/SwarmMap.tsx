import { useMemo, useState } from 'react'
import type { Node, NodesResponse } from '../../shared/types'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { DeviceGlyph } from '../components/DeviceGlyph'
import { EmptyState } from '../components/EmptyState'
import { PlusIcon, RefreshIcon, SendIcon, SwarmIcon, WifiOffIcon } from '../components/Icons'
import { PageHeader } from '../components/PageHeader'
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

export function SwarmMap({ data, loading, ipcError, platform, onRetry, onSendTask, activePeers }: SwarmMapProps) {
  const wide = useMediaQuery('(min-width: 900px)', true)
  const [layout, setLayout] = useState<Layout>('map')
  useNow(30_000)

  const peers = useMemo(() => sortPeers(data?.nodes ?? []), [data])
  const online = peers.filter((n) => n.online).length
  const tailscaleProblem = !!data?.error && peers.length === 0
  const radial = layout === 'map' && wide && peers.length <= MAX_RADIAL

  const subtitle = loading && !data
    ? 'Looking for your computers…'
    : peers.length === 0
      ? 'Only this computer so far'
      : `${online} of ${peers.length} other ${peers.length === 1 ? 'computer' : 'computers'} online`

  return (
    <>
      <PageHeader
        title="Your swarm"
        subtitle={subtitle}
        actions={
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
                      layout === l ? 'bg-surface-3 text-ink shadow-soft' : 'text-ink-muted hover:text-ink'
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
        }
      />

      {loading && !data ? (
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
      ) : tailscaleProblem ? (
        <Card>
          <EmptyState
            tone="warn"
            icon={<WifiOffIcon size={26} />}
            title="Tailscale isn’t connected"
            action={
              <Button variant="primary" icon={<RefreshIcon size={16} />} onClick={onRetry}>
                Retry
              </Button>
            }
          >
            <p>AirBridge uses Tailscale to find your other computers.</p>
            <p className="mt-1 font-medium text-ink">Open Tailscale and sign in, then press Retry.</p>
          </EmptyState>
        </Card>
      ) : peers.length === 0 ? (
        <EmptySwarm self={data?.self} platform={platform} />
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
      className={`relative flex rounded-2xl border border-accent/30 bg-surface-1 shadow-glow ${
        compact ? 'w-full flex-row items-center gap-3 p-4 text-left' : 'w-[200px] shrink-0 flex-col items-center px-5 pb-5 pt-6 text-center'
      }`}
    >
      <div className="relative">
        {!compact ? <span aria-hidden="true" className="absolute -inset-3 rounded-full bg-accent/20 blur-xl animate-breathe" /> : null}
        <DeviceGlyph os={self?.os ?? platform} size={compact ? 20 : 26} tone="accent" className={compact ? 'h-10 w-10 rounded-xl' : 'relative h-14 w-14 rounded-2xl'} />
      </div>
      <div className={compact ? 'min-w-0 flex-1' : 'mt-3 min-w-0'}>
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-accent-ink">{thisComputerLabel(platform)}</p>
        <p className="mt-0.5 truncate text-[15px] font-semibold text-ink selectable">{self?.hostname ?? '—'}</p>
        <p className="mt-0.5 truncate font-mono text-[11.5px] text-ink-faint selectable">{self?.ip ?? ''}</p>
      </div>
      {compact ? <StatusDot status="online" label="You" pulse={false} /> : null}
    </div>
  )
}

function PeerCard({ node, onSendTask, className = '' }: { node: Node; onSendTask: (t?: string) => void; className?: string }) {
  const body = (
    <>
      <DeviceGlyph os={node.os} size={20} tone={node.online ? 'neutral' : 'muted'} className="h-10 w-10 rounded-xl" />
      <span className="min-w-0 flex-1 text-left">
        <span className={`block truncate text-[14px] font-semibold ${node.online ? 'text-ink' : 'text-ink-muted'}`}>
          {node.hostname}
        </span>
        <span className="block truncate text-[12px] text-ink-faint">{osLabel(node.os)}</span>
        <span className="mt-1.5 block">
          {node.online ? (
            <StatusDot status="online" />
          ) : (
            <>
              <StatusDot status="offline" />
              <span className="mt-0.5 block truncate text-[11.5px] text-ink-faint">
                Last seen {relativeTime(node.last_seen)}
              </span>
            </>
          )}
        </span>
      </span>
    </>
  )
  const cls = `flex w-[208px] items-start gap-3 rounded-2xl border p-3.5 shadow-soft transition duration-200 ease-calm ${className}`
  if (!node.online) {
    return (
      <div className={`${cls} border-line/[0.06] bg-surface-1/80`} data-testid="peer-card">
        {body}
      </div>
    )
  }
  return (
    <button
      type="button"
      data-testid="peer-card"
      onClick={() => onSendTask(node.hostname)}
      aria-label={`${node.hostname}, ${osLabel(node.os)}, online. Send a task`}
      className={`${cls} group border-line/10 bg-surface-1 hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-lift motion-reduce:hover:translate-y-0`}
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
      aria-label="Swarm map"
      className="map-backdrop relative h-[clamp(460px,calc(100vh-190px),680px)] overflow-hidden rounded-2xl border border-line/[0.06] bg-surface-1/40"
    >
      {/* Soft vignette so cards float. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgb(var(--accent)/0.08),transparent_60%)]" />
      <svg
        className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {peers.map((n, i) => {
          const { x, y } = pos[i]
          const d = `M50 50 L${x.toFixed(2)} ${y.toFixed(2)}`
          const active = activePeers?.has(n.hostname)
          return n.online ? (
            <g key={n.hostname}>
              <path d={d} stroke="rgb(var(--accent))" strokeOpacity={active ? 0.7 : 0.28} strokeWidth={active ? 2.5 : 1.5} vectorEffect="non-scaling-stroke" fill="none" className="transition-all duration-500" />
              <path
                d={d}
                pathLength={100}
                stroke="rgb(var(--accent-ink))"
                strokeWidth={3}
                strokeLinecap="round"
                strokeDasharray="4 96"
                vectorEffect="non-scaling-stroke"
                fill="none"
                className="animate-packet"
                style={{ animationDelay: `${(i * 0.45) % 2.8}s` }}
              />
            </g>
          ) : (
            <path
              key={n.hostname}
              d={d}
              stroke="rgb(var(--line))"
              strokeOpacity={0.14}
              strokeWidth={1.25}
              strokeDasharray="3 6"
              vectorEffect="non-scaling-stroke"
              fill="none"
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
            className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 animate-fade-in"
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
    <section aria-label="Swarm list" className="space-y-4">
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

function EmptySwarm({ self, platform }: { self?: NodesResponse['self']; platform: string }) {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="map-backdrop relative flex min-h-[320px] items-center justify-center gap-6 overflow-hidden rounded-2xl border border-line/[0.06] bg-surface-1/40 p-8">
        <SelfCard self={self} platform={platform} />
        <svg width="56" height="8" viewBox="0 0 56 8" aria-hidden="true" className="hidden shrink-0 text-line/30 xl:block">
          <path d="M0 4h56" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 5" />
        </svg>
        <div
          aria-hidden="true"
          className="hidden h-[148px] w-[160px] shrink-0 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line/20 text-ink-faint xl:flex"
        >
          <PlusIcon size={22} />
          <span className="text-[12px] font-medium">Your next computer</span>
        </div>
      </div>
      <Card className="flex flex-col justify-center">
        <div className="mb-4 grid h-11 w-11 place-items-center rounded-xl bg-accent/10 text-accent-ink ring-1 ring-inset ring-accent/20">
          <SwarmIcon size={22} />
        </div>
        <h2 className="text-[17px] font-semibold tracking-tightish">Just this computer so far</h2>
        <p className="mt-2 text-[14px] leading-6 text-ink-muted">
          AirBridge links your computers with <strong className="font-semibold text-ink">Tailscale</strong> — a free
          app that connects your own devices privately, as if they were on the same Wi‑Fi, wherever they are.
        </p>
        <ol className="mt-5 space-y-3">
          {[
            ['Install Tailscale on your other computer', 'Sign in with the same account you use here.'],
            ['Install AirBridge Pro there too', 'Sign in, and it will appear on this map by itself.']
          ].map(([title, body], i) => (
            <li key={title} className="flex gap-3">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent text-[12px] font-semibold text-accent-fg">
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
      <span className="sr-only">Looking for your computers…</span>
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
