import type { ReactNode } from 'react'

export function PageHeader({
  title,
  subtitle,
  actions
}: {
  title: string
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="app-drag flex flex-wrap items-end justify-between gap-4 pb-6 pt-10">
      <div className="min-w-0">
        <h1 tabIndex={-1} className="text-[26px] font-semibold leading-8 tracking-display text-ink">{title}</h1>
        {subtitle ? <p className="mt-1 text-[14px] text-ink-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="app-no-drag flex items-center gap-2">{actions}</div> : null}
    </header>
  )
}
