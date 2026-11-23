import { deviceKind } from '../lib/format'
import { DesktopIcon, LaptopIcon, PhoneIcon, TerminalIcon } from './Icons'

/** Device icon from hostname hints, then OS (see deviceKind). */
export function DeviceGlyph({
  os,
  hostname,
  size = 22,
  className = '',
  tone = 'neutral'
}: {
  os: string | null | undefined
  hostname?: string | null
  size?: number
  className?: string
  tone?: 'neutral' | 'muted'
}) {
  const kind = deviceKind(os, hostname)
  const Icon =
    kind === 'laptop' ? LaptopIcon : kind === 'phone' ? PhoneIcon : kind === 'server' ? TerminalIcon : DesktopIcon
  const tones = {
    neutral: 'bg-line/[0.06] text-ink ring-line/10',
    muted: 'bg-line/[0.04] text-ink-faint ring-line/[0.06]'
  }
  return (
    <span className={`grid shrink-0 place-items-center ring-1 ring-inset ${tones[tone]} ${className}`} aria-hidden="true" data-device={kind}>
      <Icon size={size} />
    </span>
  )
}
