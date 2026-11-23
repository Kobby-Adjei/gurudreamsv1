import { osKind } from '../lib/format'
import { DesktopIcon, LaptopIcon, PhoneIcon, TerminalIcon } from './Icons'

/** Device icon by OS: Mac → laptop, Windows → monitor, Linux → terminal. */
export function DeviceGlyph({
  os,
  size = 22,
  className = '',
  tone = 'neutral'
}: {
  os: string | null | undefined
  size?: number
  className?: string
  tone?: 'neutral' | 'accent' | 'muted'
}) {
  const kind = osKind(os)
  const Icon =
    kind === 'mac' ? LaptopIcon : kind === 'windows' ? DesktopIcon : kind === 'phone' ? PhoneIcon : kind === 'linux' ? TerminalIcon : DesktopIcon
  const tones = {
    neutral: 'bg-line/[0.06] text-ink ring-line/10',
    accent: 'bg-accent/15 text-accent-ink ring-accent/30',
    muted: 'bg-line/[0.04] text-ink-faint ring-line/[0.06]'
  }
  return (
    <span className={`grid shrink-0 place-items-center ring-1 ring-inset ${tones[tone]} ${className}`} aria-hidden="true">
      <Icon size={size} />
    </span>
  )
}
