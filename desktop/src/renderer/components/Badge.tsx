import type { ReactNode } from 'react'

type Tone = 'neutral' | 'ok' | 'warn'

const tones: Record<Tone, string> = {
  neutral: 'bg-line/[0.06] text-ink-muted ring-line/10',
  ok: 'bg-ok/10 text-ok ring-ok/20',
  warn: 'bg-warn/10 text-warn ring-warn/25'
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex h-5 items-center rounded-full px-2 text-2xs font-semibold uppercase tracking-wide ring-1 ring-inset ${tones[tone]}`}
    >
      {children}
    </span>
  )
}
