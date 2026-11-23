import type { ReactNode } from 'react'

export function EmptyState({
  icon,
  title,
  children,
  action,
  tone = 'neutral',
  headingLevel = 2
}: {
  icon: ReactNode
  title: string
  children?: ReactNode
  action?: ReactNode
  tone?: 'neutral' | 'warn'
  headingLevel?: 2 | 3
}) {
  const H = headingLevel === 2 ? 'h2' : 'h3'
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-12 text-center">
      <div
        className={`mb-5 grid h-14 w-14 place-items-center rounded-2xl ring-1 ring-inset ${
          tone === 'warn' ? 'bg-warn/10 text-warn ring-warn/20' : 'bg-line/[0.05] text-ink-muted ring-line/10'
        }`}
      >
        {icon}
      </div>
      <H className="text-[17px] font-semibold tracking-tightish text-ink">{title}</H>
      {children ? <div className="mt-2 text-[14px] leading-6 text-ink-muted">{children}</div> : null}
      {action ? <div className="mt-6 flex flex-wrap items-center justify-center gap-3">{action}</div> : null}
    </div>
  )
}
