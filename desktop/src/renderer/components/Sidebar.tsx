import type { ReactNode } from 'react'
import type { AuthUser, LicenseStatus } from '../../shared/types'
import { initials, planLabel } from '../lib/format'
import { Badge } from './Badge'
import { ActivityIcon, LogoMark, SettingsIcon, SwarmIcon } from './Icons'
import { StatusDot, type DotStatus } from './StatusDot'

export type ViewId = 'swarm' | 'activity' | 'settings'

const NAV: { id: ViewId; label: string; icon: ReactNode }[] = [
  { id: 'swarm', label: 'Swarm', icon: <SwarmIcon /> },
  { id: 'activity', label: 'Activity', icon: <ActivityIcon /> },
  { id: 'settings', label: 'Settings', icon: <SettingsIcon /> }
]

export function Sidebar({
  current,
  onNavigate,
  user,
  license,
  onlineCount,
  unseenActivity = 0,
  service = { status: 'online', label: 'AirBridge is running' }
}: {
  current: ViewId
  onNavigate: (v: ViewId) => void
  user?: AuthUser
  license: LicenseStatus | null
  onlineCount: number | null
  unseenActivity?: number
  service?: { status: DotStatus; label: string }
}) {
  const name = user?.name || user?.email?.split('@')[0] || 'You'
  return (
    <aside className="flex w-[232px] shrink-0 flex-col border-r border-line/[0.06] bg-surface-1/60 backdrop-blur-xl">
      {/* Leaves room for macOS traffic lights and makes the top draggable. */}
      <div className="app-drag h-10 shrink-0" />
      <div className="flex items-center gap-2.5 px-5 pb-6">
        <LogoMark size={28} />
        <div className="leading-tight">
          <p className="text-[15px] font-semibold tracking-tightish text-ink">AirBridge</p>
          <p className="text-2xs font-medium uppercase tracking-[0.08em] text-ink-faint">Pro</p>
        </div>
      </div>

      <nav aria-label="Main" className="flex-1 px-3">
        <ul className="space-y-0.5">
          {NAV.map((item) => {
            const active = item.id === current
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onNavigate(item.id)}
                  aria-current={active ? 'page' : undefined}
                  className={`app-no-drag group flex h-9 w-full items-center gap-3 rounded-xl px-3 text-[14px] font-medium transition duration-150 ease-calm ${
                    active
                      ? 'bg-line/[0.08] text-ink shadow-inset-line'
                      : 'text-ink-muted hover:bg-line/[0.04] hover:text-ink'
                  }`}
                >
                  <span className={active ? 'text-accent-ink' : 'text-ink-faint group-hover:text-ink-muted'}>
                    {item.icon}
                  </span>
                  <span className="flex-1 text-left">{item.label}</span>
                  {item.id === 'swarm' && onlineCount !== null ? (
                    <span className="text-[12px] tabular-nums text-ink-faint" aria-label={`${onlineCount} online`}>
                      {onlineCount}
                    </span>
                  ) : null}
                  {item.id === 'activity' && unseenActivity > 0 ? (
                    <span className="grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1.5 text-2xs font-semibold text-accent-fg">
                      <span aria-hidden="true">{unseenActivity > 99 ? '99+' : unseenActivity}</span>
                      <span className="sr-only">{unseenActivity} new</span>
                    </span>
                  ) : null}
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

      <div className="m-3 rounded-2xl border border-line/[0.06] bg-surface-2/60 p-3">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-accent-hover to-accent text-[12px] font-semibold text-accent-fg"
          >
            {initials(user?.name || user?.email)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-ink" title={user?.email}>
              {name}
            </p>
            <p className="truncate text-[12px] text-ink-faint">{user?.email ?? 'Signed in'}</p>
          </div>
          <Badge tone={license?.state === 'valid' || license?.state === 'grace' ? 'accent' : 'neutral'}>
            {planLabel(license?.plan)}
          </Badge>
        </div>
        <div className="mt-3 border-t border-line/[0.06] pt-2.5">
          <StatusDot status={service.status} label={service.label} />
        </div>
      </div>
    </aside>
  )
}
