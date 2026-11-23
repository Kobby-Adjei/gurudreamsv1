import type { AirEvent, AirEventType } from '../../shared/types'

export type OsKind = 'mac' | 'windows' | 'linux' | 'phone' | 'unknown'

/** Tailscale reports OS as "macOS", "windows", "linux", "iOS", "android"… */
export function osKind(os: string | null | undefined): OsKind {
  const s = (os ?? '').toLowerCase()
  if (s.includes('mac') || s.includes('darwin')) return 'mac'
  if (s.includes('win')) return 'windows'
  if (s.includes('ios') || s.includes('android')) return 'phone'
  if (s.includes('linux') || s.includes('ubuntu') || s.includes('debian') || s.includes('fedora'))
    return 'linux'
  return 'unknown'
}

export type DeviceKind = 'laptop' | 'desktop' | 'server' | 'phone'

const LAPTOP_HINT = /macbook|laptop|notebook|\bbook\b/i
const DESKTOP_HINT = /studio|imac|mini|desktop|tower|workstation|(^|[^a-z])pc([^a-z]|$)/i

/**
 * Which glyph to draw. The hostname wins when it clearly names the hardware
 * ("Studio-Mac", "Mac-mini", "Desktop-PC", "MacBook-Pro"); otherwise the OS
 * decides: Mac → laptop, Windows → desktop, Linux → server.
 */
export function deviceKind(os: string | null | undefined, hostname?: string | null): DeviceKind {
  const kind = osKind(os)
  if (kind === 'phone') return 'phone'
  const name = hostname ?? ''
  if (LAPTOP_HINT.test(name)) return 'laptop'
  if (DESKTOP_HINT.test(name)) return 'desktop'
  if (kind === 'mac') return 'laptop'
  if (kind === 'linux') return 'server'
  return 'desktop'
}

export function osLabel(os: string | null | undefined): string {
  switch (osKind(os)) {
    case 'mac':
      return 'Mac'
    case 'windows':
      return 'Windows PC'
    case 'linux':
      return 'Linux'
    case 'phone':
      return 'Phone'
    default:
      return 'Computer'
  }
}

/** Short, human relative time: "just now", "5 min ago", "Yesterday", "Mar 4". */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'a while ago'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 'a while ago'
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`
  const d = Math.round(h / 24)
  if (d === 1) return 'Yesterday'
  if (d < 7) return `${d} days ago`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function absoluteTime(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  return new Date(t).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function formatUptime(seconds: number): string {
  if (seconds < 60) return 'less than a minute'
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ${m % 60} min`
  const d = Math.floor(h / 24)
  return `${d} d ${h % 24} h`
}

export type EventTone = 'received' | 'sent' | 'problem' | 'info'

export const PROBLEM_TYPES: readonly AirEventType[] = ['send_failed', 'inbox_degraded']

export function eventTone(type: AirEventType): EventTone {
  if (type === 'task_received') return 'received'
  if (type === 'task_sent') return 'sent'
  if (PROBLEM_TYPES.includes(type)) return 'problem'
  return 'info'
}

/**
 * Turn a daemon event into one plain-English sentence. The daemon's own
 * `summary` is shown underneath as secondary detail. For `task_sent` the daemon
 * mentions "code" in the summary when a code payload was attached, which lets
 * us say "Sent code to …" instead of "Sent a task to …".
 */
export function eventSentence(e: AirEvent): string {
  const peer = e.peer?.trim() || 'another computer'
  switch (e.type) {
    case 'task_received':
      return `Received task from ${peer}`
    case 'task_sent':
      return /\bcode\b/i.test(e.summary) ? `Sent code to ${peer}` : `Sent a task to ${peer}`
    case 'send_failed':
      if (/too large|413|limit/i.test(e.detail?.error ?? ''))
        return `That task was too big to send to ${peer}`
      return `Couldn’t reach ${peer} — is it awake?`
    case 'node_online':
      return `${peer} came online`
    case 'node_offline':
      return `${peer} went offline`
    case 'inbox_listening':
      return 'Ready to receive tasks'
    case 'inbox_degraded':
      return 'This computer can’t receive tasks right now'
    case 'daemon_started':
      return 'AirBridge started'
    case 'daemon_stopping':
      return 'AirBridge stopped'
    default:
      return e.summary || 'Something happened'
  }
}

/** Secondary line for an event (never repeats the headline). */
export function eventDetail(e: AirEvent): string | null {
  const parts: string[] = []
  if (e.type === 'task_received' && e.detail?.file) parts.push(`Saved as ${e.detail.file}`)
  if (e.detail?.bytes && (e.type === 'task_received' || e.type === 'task_sent'))
    parts.push(formatBytes(e.detail.bytes))
  if (e.type === 'inbox_degraded' && e.detail?.error) parts.push(e.detail.error)
  if (e.type === 'send_failed') parts.push('Make sure it’s turned on and signed in to Tailscale.')
  if (e.origin === 'mcp' && (e.type === 'task_sent' || e.type === 'send_failed'))
    parts.push('from your AI app')
  return parts.length ? parts.join(' · ') : null
}

export function initials(nameOrEmail: string | undefined | null): string {
  const s = (nameOrEmail ?? '').trim()
  if (!s) return '?'
  const base = s.includes('@') ? s.split('@')[0] : s
  const words = base.split(/[\s._-]+/).filter(Boolean)
  const letters = words.length > 1 ? words[0][0] + words[1][0] : base.slice(0, 2)
  return letters.toUpperCase()
}

export function planLabel(plan: string | null | undefined): string {
  if (!plan) return 'Free'
  if (plan === 'airbridge_pro') return 'Pro'
  return plan.replace(/^airbridge_/, '').replace(/^\w/, (c) => c.toUpperCase())
}

export function platformLabel(p: string): string {
  if (p === 'darwin') return 'macOS'
  if (p === 'win32') return 'Windows'
  if (p === 'linux') return 'Linux'
  return p
}

/** What the user calls the machine they're sitting at. */
export function thisComputerLabel(platform: string): string {
  if (platform === 'darwin') return 'This Mac'
  if (platform === 'win32') return 'This PC'
  return 'This computer'
}
