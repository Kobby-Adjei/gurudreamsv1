import { useMemo, useState, type ReactNode } from 'react'
import type { AirEvent } from '../../shared/types'
import { Card } from '../components/Card'
import { CopyButton } from '../components/CopyButton'
import { EmptyState } from '../components/EmptyState'
import {
  ActivityIcon,
  AlertIcon,
  FolderIcon,
  InfoIcon,
  PowerIcon,
  ReceiveIcon,
  SendIcon,
  SwarmIcon
} from '../components/Icons'
import { PageHeader } from '../components/PageHeader'
import { SkeletonRows } from '../components/Skeleton'
import { useNow } from '../lib/hooks'
import {
  absoluteTime,
  eventDetail,
  eventSentence,
  eventTone,
  relativeTime,
  type EventTone
} from '../lib/format'

export type FeedFilter = 'all' | 'received' | 'sent' | 'problems'

const FILTERS: { id: FeedFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'received', label: 'Received' },
  { id: 'sent', label: 'Sent' },
  { id: 'problems', label: 'Problems' }
]

function matches(filter: FeedFilter, e: AirEvent): boolean {
  const tone = eventTone(e.type)
  if (filter === 'all') return true
  if (filter === 'received') return tone === 'received'
  if (filter === 'sent') return tone === 'sent'
  return tone === 'problem'
}

const toneStyle: Record<EventTone, string> = {
  received: 'bg-accent/15 text-accent-ink ring-accent/25',
  sent: 'bg-ok/10 text-ok ring-ok/20',
  problem: 'bg-danger/10 text-danger ring-danger/25',
  info: 'bg-line/[0.06] text-ink-muted ring-line/10'
}

function iconFor(e: AirEvent): ReactNode {
  switch (e.type) {
    case 'task_received':
      return <ReceiveIcon size={17} />
    case 'task_sent':
      return <SendIcon size={16} />
    case 'send_failed':
    case 'inbox_degraded':
      return <AlertIcon size={17} />
    case 'node_online':
    case 'node_offline':
      return <SwarmIcon size={17} />
    case 'daemon_started':
    case 'daemon_stopping':
      return <PowerIcon size={17} />
    default:
      return <InfoIcon size={17} />
  }
}

const INBOX_HINT_PATH = '~/Desktop/AirBridge_Inbox'

export function ActivityFeed({
  events,
  loading,
  freshIds
}: {
  events: AirEvent[]
  loading: boolean
  freshIds: ReadonlySet<string>
}) {
  const [filter, setFilter] = useState<FeedFilter>('all')
  const now = useNow(30_000)

  const counts = useMemo(() => {
    const c: Record<FeedFilter, number> = { all: events.length, received: 0, sent: 0, problems: 0 }
    for (const e of events) {
      const t = eventTone(e.type)
      if (t === 'received') c.received++
      else if (t === 'sent') c.sent++
      else if (t === 'problem') c.problems++
    }
    return c
  }, [events])

  const visible = useMemo(() => events.filter((e) => matches(filter, e)), [events, filter])
  const latest = events[0]

  return (
    <>
      <PageHeader title="Activity" subtitle="Everything your swarm has been up to, as it happens." />

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Filter activity" className="flex flex-wrap gap-2">
          {FILTERS.map((f) => {
            const active = filter === f.id
            return (
              <button
                key={f.id}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(f.id)}
                className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium transition duration-150 ease-calm ${
                  active
                    ? 'border-transparent bg-ink text-canvas'
                    : 'border-line/10 bg-surface-1 text-ink-muted hover:border-line/20 hover:text-ink'
                }`}
              >
                {f.id === 'problems' && counts.problems > 0 && !active ? (
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-danger" />
                ) : null}
                {f.label}
                <span className={`tabular-nums ${active ? 'opacity-70' : 'text-ink-faint'}`}>{counts[f.id]}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Announce new live items for screen-reader users without re-reading the list. */}
      <p className="sr-only" aria-live="polite">
        {latest && freshIds.has(latest.id) ? eventSentence(latest) : ''}
      </p>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
        <Card padded={false} className="overflow-hidden">
          {loading && events.length === 0 ? (
            <div className="p-3">
              <SkeletonRows rows={6} label="Loading activity" />
            </div>
          ) : visible.length === 0 ? (
            <EmptyState
              icon={filter === 'problems' ? <AlertIcon size={26} /> : <ActivityIcon size={26} />}
              title={
                filter === 'problems'
                  ? 'No problems — all good'
                  : events.length === 0
                    ? 'Nothing yet'
                    : 'Nothing here yet'
              }
            >
              {filter === 'problems'
                ? 'If a computer can’t be reached, you’ll see it here.'
                : 'When your AI apps send or receive tasks, they’ll show up here in real time.'}
            </EmptyState>
          ) : (
            <ol aria-label="Activity" className="divide-y divide-line/[0.06]">
              {visible.map((e) => {
                const tone = eventTone(e.type)
                const detail = eventDetail(e)
                return (
                  <li
                    key={e.id}
                    className={`flex items-start gap-4 px-5 py-4 transition-colors hover:bg-line/[0.025] ${
                      freshIds.has(e.id) ? 'animate-enter bg-accent/[0.04]' : ''
                    }`}
                  >
                    <span className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full ring-1 ring-inset ${toneStyle[tone]}`}>
                      {iconFor(e)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] font-medium leading-5 text-ink">{eventSentence(e)}</p>
                      {detail ? <p className="mt-0.5 truncate text-[13px] text-ink-faint selectable">{detail}</p> : null}
                    </div>
                    <time
                      dateTime={e.ts}
                      title={absoluteTime(e.ts)}
                      className="shrink-0 pt-0.5 text-[12px] tabular-nums text-ink-faint"
                    >
                      {relativeTime(e.ts, now)}
                    </time>
                  </li>
                )
              })}
            </ol>
          )}
        </Card>

        <aside aria-label="Where tasks go" className="space-y-4">
          <Card className="!p-5">
            <div className="mb-3 grid h-9 w-9 place-items-center rounded-xl bg-accent/10 text-accent-ink ring-1 ring-inset ring-accent/20">
              <FolderIcon size={18} />
            </div>
            <h2 className="text-[14px] font-semibold">Open inbox folder</h2>
            <p className="mt-1 text-[13px] leading-5 text-ink-muted">
              Tasks you receive are saved as files in your inbox folder. Your AI app reads them from there.
            </p>
            <code className="mt-3 block truncate rounded-lg bg-canvas px-3 py-2 font-mono text-[12px] text-ink-muted">
              {INBOX_HINT_PATH}
            </code>
            <div className="mt-3">
              <CopyButton
                variant="secondary"
                size="sm"
                label="Copy path"
                onCopy={() => navigator.clipboard.writeText(INBOX_HINT_PATH)}
              />
            </div>
          </Card>
          <p className="px-1 text-[12px] leading-5 text-ink-faint">
            AirBridge only records what happened — never the contents of your tasks or code.
          </p>
        </aside>
      </div>
    </>
  )
}
