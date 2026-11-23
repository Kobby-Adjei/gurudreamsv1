import type { SVGProps } from 'react'

/**
 * Hand-drawn 24×24 line icons (1.75 stroke, round caps) – no icon dependency.
 * Decorative by default (aria-hidden); pass `title` to make one meaningful.
 */
type IconProps = SVGProps<SVGSVGElement> & { title?: string; size?: number }

function Svg({ title, size = 20, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  )
}

export const SwarmIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="2.5" />
    <circle cx="5" cy="6" r="1.75" />
    <circle cx="19" cy="6" r="1.75" />
    <circle cx="5" cy="18" r="1.75" />
    <circle cx="19" cy="18" r="1.75" />
    <path d="M6.5 7.2 10 10.3M17.5 7.2 14 10.3M6.5 16.8 10 13.7M17.5 16.8 14 13.7" />
  </Svg>
)

export const ActivityIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12h3.5l2.5-6 4 12 2.5-6H21" />
  </Svg>
)

export const SettingsIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </Svg>
)

export const LaptopIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="5" width="16" height="11" rx="1.75" />
    <path d="M2 19h20" />
  </Svg>
)

export const DesktopIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="12" rx="1.75" />
    <path d="M9 20h6M12 16v4" />
  </Svg>
)

export const TerminalIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m7 9 3 3-3 3M12.5 15H17" />
  </Svg>
)

export const PhoneIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
    <path d="M11 18.5h2" />
  </Svg>
)

export const SendIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 3 10.5 13.5" />
    <path d="M21 3 14.5 21l-4-7.5L3 9.5 21 3Z" />
  </Svg>
)

export const ReceiveIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v11M7.5 9.5 12 14l4.5-4.5" />
    <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </Svg>
)

export const AlertIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9.5v4M12 17h.01" />
  </Svg>
)

export const InfoIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </Svg>
)

export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
)

export const CopyIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.25" />
    <path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5" />
  </Svg>
)

export const RefreshIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" />
    <path d="M4 4v4h4" />
    <path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" />
    <path d="M20 20v-4h-4" />
  </Svg>
)

export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
)

export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)

export const FolderIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-10Z" />
  </Svg>
)

export const PowerIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v8" />
    <path d="M6.3 7.3a8 8 0 1 0 11.4 0" />
  </Svg>
)

export const ArrowRightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
)

export const LinkIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" />
    <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" />
  </Svg>
)

export const ShieldIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6L12 3Z" />
    <path d="m9 12 2 2 4-4" />
  </Svg>
)

export const SparkIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5 13.8 9a2 2 0 0 0 1.2 1.2l5.5 1.8-5.5 1.8a2 2 0 0 0-1.2 1.2L12 20.5 10.2 15A2 2 0 0 0 9 13.8L3.5 12 9 10.2A2 2 0 0 0 10.2 9L12 3.5Z" />
  </Svg>
)

export const CodeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14" />
  </Svg>
)

export const WifiOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 3l18 18" />
    <path d="M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 4.5-2.6M19 13a10 10 0 0 0-2.2-1.6M2 9.5a15 15 0 0 1 4.3-2.7M22 9.5A15 15 0 0 0 10.7 5.6" />
    <path d="M12 20h.01" />
  </Svg>
)

/**
 * App mark: the A-frame pylon. A bridge tower that doubles as the "A" of
 * AirBridge, with a short mast head, flat-cut feet and a road deck that runs
 * past both legs so it reads as a pylon rather than a letter. Monochrome via
 * currentColor; legs are 2.4 units wide so it stays crisp at 16px.
 * Source of truth: docs/brand/logo.svg.
 */
export function LogoMark({ size = 20, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" className={className}>
      <path d="M10.875 1.5h2.25v2.3l6.825 18.7h-2.4L12 7.3 6.45 22.5h-2.4l6.825-18.7V1.5Z" />
      <rect x="0" y="15" width="24" height="2.25" rx="0.75" />
    </svg>
  )
}
