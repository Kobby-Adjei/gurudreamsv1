import { useState, type ReactNode } from 'react'
import type { AuthState, AuthUser } from '../../shared/types'
import { api, errorText } from '../lib/api'
import { initials, planLabel } from '../lib/format'
import type { LicenseView } from '../lib/preview'
import { Badge } from './Badge'
import type { NetworkState } from '../lib/network'
import { ActivityIcon, LaptopIcon, LogoMark, SettingsIcon } from './Icons'
import { PrivateNetworkStatusLine } from './PrivateNetworkCard'
import { StatusDot, type DotStatus } from './StatusDot'
import { useToast } from './Toast'

export type ViewId = 'swarm' | 'activity' | 'settings'

const NAV: { id: ViewId; label: string; icon: ReactNode }[] = [
  { id: 'swarm', label: 'Devices', icon: <LaptopIcon /> },
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
  service,
  network,
  preview
}: {
  current: ViewId
  onNavigate: (v: ViewId) => void
  user?: AuthUser
  license: LicenseView | null
  onlineCount: number | null
  unseenActivity?: number
  /** Only passed when the background service needs attention. */
  service?: { status: DotStatus; label: string } | null
  network?: NetworkState
  /** Preview mode: sign-in is optional and the plan reads “Preview”. */
  preview?: { auth: AuthState }
}) {
  const name = user?.name || user?.email?.split('@')[0] || 'You'
  const signedIn = !preview || preview.auth.state === 'signed_in'
  return (
    <aside className="flex w-[232px] shrink-0 flex-col border-r border-line/[0.06] bg-surface-1">
      {/* Leaves room for macOS traffic lights and makes the top draggable. */}
      <div className="app-drag h-10 shrink-0" />
      <div className="flex items-center gap-2 px-5 pb-6 text-ink">
        <LogoMark size={18} />
        <p className="text-[15px] font-normal tracking-tightish">AirBridge</p>
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
                      ? 'bg-line/[0.08] text-ink'
                      : 'text-ink-muted hover:bg-line/[0.04] hover:text-ink'
                  }`}
                >
                  <span className={active ? 'text-ink' : 'text-ink-faint group-hover:text-ink-muted'}>
                    {item.icon}
                  </span>
                  <span className="flex-1 text-left">{item.label}</span>
                  {item.id === 'swarm' && onlineCount !== null ? (
                    <span
                      className="inline-flex items-center gap-1.5 text-[12px] tabular-nums text-ink-faint"
                      aria-label={`${onlineCount} online`}
                    >
                      <span aria-hidden="true">{onlineCount} online</span>
                    </span>
                  ) : null}
                  {item.id === 'activity' && unseenActivity > 0 ? (
                    <span className="grid h-5 min-w-5 place-items-center rounded-full bg-line/10 px-1.5 text-2xs font-semibold text-ink">
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

      <div className="m-3 rounded-2xl border border-line/[0.06] bg-surface-2 p-3">
        {!signedIn && preview ? (
          <PreviewSignIn signingIn={preview.auth.state === 'signing_in'} />
        ) : (
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-3 text-[12px] font-medium text-ink-muted"
            >
              {initials(user?.name || user?.email)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-[13px] font-medium text-ink" title={user?.email}>
                <span className="min-w-0 truncate">{name}</span>
                {preview ? <PreviewLabel /> : <Badge tone="neutral">{planLabel(license?.plan)}</Badge>}
              </p>
              <p className="truncate text-[12px] text-ink-faint">{user?.email ?? 'Signed in'}</p>
            </div>
          </div>
        )}
        {network || service ? (
          <div className="mt-3 space-y-1.5 border-t border-line/[0.06] pt-2.5">
            {network ? <PrivateNetworkStatusLine network={network} /> : null}
            {service ? <StatusDot status={service.status} label={service.label} className="min-w-0 truncate" /> : null}
          </div>
        ) : null}
      </div>
    </aside>
  )
}

/** A quiet grey word, not a badge: the app is in preview. */
function PreviewLabel() {
  return <span className="shrink-0 text-[11px] font-medium text-ink-faint">Preview</span>
}

/** Preview, signed out: an optional, low-key way to sign in. */
function PreviewSignIn({ signingIn }: { signingIn: boolean }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  async function signIn() {
    setBusy(true)
    try {
      await api().auth.signIn()
    } catch (err) {
      toast.show({ tone: 'error', title: 'Couldn’t start sign-in', body: errorText(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-8 items-center justify-between gap-3" data-testid="account-footer">
      {signingIn ? (
        <span className="text-[13px] text-ink-muted">Finish signing in in the browser…</span>
      ) : (
        <button
          type="button"
          onClick={signIn}
          disabled={busy}
          className="app-no-drag -mx-1 rounded-md px-1 text-[13px] font-medium text-ink-muted hover:text-ink disabled:opacity-60"
        >
          Sign in
        </button>
      )}
      <PreviewLabel />
    </div>
  )
}
