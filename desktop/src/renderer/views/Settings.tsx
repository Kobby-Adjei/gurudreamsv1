import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { AuthUser, BackendLifecycle, BackendStatus, LicenseStatus, McpClient } from '../../shared/types'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Card, CardHeader } from '../components/Card'
import { CopyButton } from '../components/CopyButton'
import { ArrowRightIcon } from '../components/Icons'
import { PageHeader } from '../components/PageHeader'
import { Skeleton } from '../components/Skeleton'
import { StatusDot, type DotStatus } from '../components/StatusDot'
import { useToast } from '../components/Toast'
import { api, errorText } from '../lib/api'
import { formatUptime, planLabel, platformLabel } from '../lib/format'

const CLIENTS: { id: McpClient; label: string; steps: [string, ReactNode][] }[] = [
  {
    id: 'claude',
    label: 'Claude Desktop',
    steps: [
      [
        'Open the config file',
        <>
          In Claude Desktop, open <Kbd>Settings</Kbd> → <Kbd>Developer</Kbd> → <Kbd>Edit Config</Kbd>.
        </>
      ],
      ['Paste and save', 'Replace what’s in the file with the code you copied (or add the “airbridge” entry if you already have others), then save.'],
      ['Restart Claude Desktop', 'Quit it completely and open it again. AirBridge will appear in its tools.']
    ]
  },
  {
    id: 'cursor',
    label: 'Cursor',
    steps: [
      [
        'Open MCP settings',
        <>
          In Cursor, open <Kbd>Settings</Kbd> → <Kbd>Cursor Settings</Kbd> → <Kbd>MCP</Kbd> and choose{' '}
          <Kbd>Add new MCP server</Kbd>.
        </>
      ],
      ['Paste and save', 'Paste the code you copied into the mcp.json file that opens, then save.'],
      ['Restart Cursor', 'Quit and reopen Cursor. AirBridge will show a green dot in the MCP list.']
    ]
  }
]

function Kbd({ children }: { children: ReactNode }) {
  return (
    <span className="whitespace-nowrap rounded-md border border-line/10 bg-surface-2 px-1.5 py-px text-[12.5px] font-medium text-ink">
      {children}
    </span>
  )
}

export function Settings({
  user,
  license,
  lifecycle,
  status
}: {
  user?: AuthUser
  license: LicenseStatus | null
  lifecycle: BackendLifecycle | null
  status: BackendStatus | null
}) {
  return (
    <>
      <PageHeader title="Settings" subtitle="Connect your AI apps and manage your account." />
      <div className="space-y-5 pb-10">
        <ConnectApps />
        <div className="grid gap-5 lg:grid-cols-2">
          <AccountCard user={user} license={license} />
          <ServiceCard lifecycle={lifecycle} status={status} />
        </div>
        <AboutCard />
      </div>
    </>
  )
}

function ConnectApps() {
  const [client, setClient] = useState<McpClient>('claude')
  const [json, setJson] = useState<Record<string, string>>({})
  const [loadError, setLoadError] = useState<string | null>(null)
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const baseId = useId()
  const headingId = `${baseId}-connect`
  const stepsId = `${baseId}-steps`

  useEffect(() => {
    let alive = true
    if (json[client] !== undefined) return
    setLoadError(null)
    api()
      .settings.getMcpConfig(client)
      .then((r) => alive && setJson((j) => ({ ...j, [client]: r.json })))
      .catch((err) => alive && setLoadError(errorText(err)))
    return () => {
      alive = false
    }
  }, [client, json])

  function onTabKey(e: KeyboardEvent<HTMLButtonElement>) {
    const idx = CLIENTS.findIndex((c) => c.id === client)
    let next = idx
    if (e.key === 'ArrowRight') next = (idx + 1) % CLIENTS.length
    else if (e.key === 'ArrowLeft') next = (idx - 1 + CLIENTS.length) % CLIENTS.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = CLIENTS.length - 1
    else return
    e.preventDefault()
    const id = CLIENTS[next].id
    setClient(id)
    tabRefs.current[id]?.focus()
  }

  const current = CLIENTS.find((c) => c.id === client)!
  const code = json[client]

  return (
    <Card as="section" aria-labelledby={headingId}>
      <CardHeader
        id={headingId}
        title="Connect your AI apps"
        description="Give Claude or Cursor the AirBridge tools so they can hand tasks to your other computers."
      />

      <div role="tablist" aria-label="AI app" className="mb-5 inline-flex rounded-xl border border-line/[0.08] bg-surface-2 p-1">
        {CLIENTS.map((c) => {
          const selected = c.id === client
          return (
            <button
              key={c.id}
              ref={(el) => (tabRefs.current[c.id] = el)}
              id={`${baseId}-tab-${c.id}`}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`${baseId}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setClient(c.id)}
              onKeyDown={onTabKey}
              className={`h-8 rounded-[10px] px-4 text-[13px] font-medium transition duration-150 ease-calm ${
                selected ? 'bg-surface-1 text-ink shadow-soft' : 'text-ink-muted hover:text-ink'
              }`}
            >
              {c.label}
            </button>
          )
        })}
      </div>

      <div
        id={`${baseId}-panel`}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${client}`}
        className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]"
      >
        <div className="min-w-0">
          <div className="relative overflow-hidden rounded-xl border border-line/[0.08] bg-canvas">
            <div className="flex items-center justify-between border-b border-line/[0.06] px-4 py-2">
              <span className="font-mono text-[12px] text-ink-faint">
                {client === 'claude' ? 'claude_desktop_config.json' : 'mcp.json'}
              </span>
            </div>
            {loadError ? (
              <p role="alert" className="px-4 py-6 text-[13px] text-danger">
                Couldn’t load the setup code: {loadError}
              </p>
            ) : code === undefined ? (
              <div className="space-y-2 px-4 py-4" role="status">
                <span className="sr-only">Loading setup code…</span>
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            ) : (
              <pre
                tabIndex={0}
                aria-label={`Setup code for ${current.label}`}
                className="max-h-[260px] overflow-auto whitespace-pre-wrap px-4 py-3.5 font-mono text-[12.5px] leading-5 text-ink [overflow-wrap:anywhere]"
              >
                <code>{code}</code>
              </pre>
            )}
          </div>
          <div className="mt-4 flex items-center gap-3">
            <CopyButton
              size="lg"
              label="Copy setup code"
              describedBy={stepsId}
              onCopy={() => api().settings.copyMcpConfig(client)}
            />
            <span className="text-[13px] text-ink-faint">Then follow the steps →</span>
          </div>
        </div>

        <ol id={stepsId} aria-label={`How to add AirBridge to ${current.label}`} className="space-y-4">
          {current.steps.map(([title, body], i) => (
            <li key={title} className="flex gap-3.5">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent/15 text-[13px] font-semibold text-accent-ink ring-1 ring-inset ring-accent/25">
                {i + 1}
              </span>
              <div className="pt-0.5">
                <p className="text-[14px] font-medium text-ink">{title}</p>
                <p className="mt-0.5 text-[13px] leading-6 text-ink-muted">{body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </Card>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <dt className="text-[13px] text-ink-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right text-[13px] font-medium text-ink selectable">{children}</dd>
    </div>
  )
}

function AccountCard({ user, license }: { user?: AuthUser; license: LicenseStatus | null }) {
  const toast = useToast()
  const [busy, setBusy] = useState<'checkout' | 'signout' | null>(null)
  const active = license?.state === 'valid' || license?.state === 'grace'
  const renews = license?.exp ? new Date(license.exp * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null

  async function run(kind: 'checkout' | 'signout') {
    setBusy(kind)
    try {
      if (kind === 'checkout') await api().license.openCheckout()
      else await api().auth.signOut()
    } catch (err) {
      toast.show({ tone: 'error', title: 'That didn’t work', body: errorText(err) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card as="section" aria-labelledby="account-h">
      <CardHeader id="account-h" title="Account" />
      <dl className="divide-y divide-line/[0.06] border-y border-line/[0.06]">
        <Row label="Email">{user?.email ?? '—'}</Row>
        <Row label="Plan">
          <span className="inline-flex items-center gap-2">
            AirBridge {planLabel(license?.plan)}
            <Badge tone={active ? 'ok' : 'warn'}>{active ? 'Active' : 'Inactive'}</Badge>
          </span>
        </Row>
        {license?.state === 'grace' ? (
          <Row label="Offline mode">Works until {renews}</Row>
        ) : renews ? (
          <Row label="Licence checked until">{renews}</Row>
        ) : null}
      </dl>
      <div className="mt-5 flex flex-wrap gap-3">
        <Button
          variant="secondary"
          loading={busy === 'checkout'}
          trailingIcon={<ArrowRightIcon size={15} />}
          onClick={() => run('checkout')}
        >
          Manage subscription
        </Button>
        <Button variant="ghost" loading={busy === 'signout'} onClick={() => run('signout')}>
          Sign out
        </Button>
      </div>
    </Card>
  )
}

function serviceDot(lifecycle: BackendLifecycle | null, status: BackendStatus | null): { s: DotStatus; label: string } {
  switch (lifecycle?.phase) {
    case 'running':
      return status?.inbox && !status.inbox.listening
        ? { s: 'warning', label: 'Running, but can’t receive tasks' }
        : { s: 'online', label: 'Running' }
    case 'starting':
      return { s: 'starting', label: 'Starting…' }
    case 'crashed':
      return { s: 'error', label: 'Stopped unexpectedly' }
    case 'blocked':
      return { s: 'warning', label: 'Paused' }
    default:
      return { s: 'offline', label: 'Stopped' }
  }
}

function ServiceCard({ lifecycle, status }: { lifecycle: BackendLifecycle | null; status: BackendStatus | null }) {
  const dot = serviceDot(lifecycle, status)
  return (
    <Card as="section" aria-labelledby="service-h">
      <CardHeader
        id="service-h"
        title="Background service"
        description="Runs quietly while AirBridge is open, so other computers can reach this one."
      />
      <dl className="divide-y divide-line/[0.06] border-y border-line/[0.06]">
        <Row label="Status">
          <StatusDot status={dot.s} label={dot.label} />
        </Row>
        <Row label="Receiving tasks">
          {status?.inbox
            ? status.inbox.listening
              ? `Yes, on port ${status.inbox.port}`
              : status.inbox.degraded_reason ?? 'Not right now'
            : '—'}
        </Row>
        <Row label="Tailscale address">
          <span className="font-mono text-[12.5px]">{status?.tailnet_ip ?? 'Not connected'}</span>
        </Row>
        <Row label="Running for">{status ? formatUptime(status.uptime_s) : '—'}</Row>
      </dl>
      {lifecycle?.detail && lifecycle.phase !== 'running' ? (
        <p className="mt-4 text-[13px] text-ink-muted">{lifecycle.detail}</p>
      ) : null}
    </Card>
  )
}

function AboutCard() {
  const { version, platform } = api().app
  return (
    <Card as="section" aria-labelledby="about-h" className="!py-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 id="about-h" className="text-[15px] font-semibold tracking-tightish">
            About
          </h2>
          <p className="mt-1 text-[13px] text-ink-muted">
            AirBridge Pro {version} · {platformLabel(platform)}
          </p>
        </div>
        <p className="max-w-sm text-right text-[12px] leading-5 text-ink-faint">
          Your tasks travel directly between your own computers over Tailscale. They never pass through our servers.
        </p>
      </div>
    </Card>
  )
}
