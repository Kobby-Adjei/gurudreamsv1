import type { HTMLAttributes, ReactNode } from 'react'

interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'section' | 'article' | 'li'
  padded?: boolean
  children: ReactNode
}

/** Rounded-2xl surface with a hairline border. No shadow: hierarchy comes from layout. */
export function Card({ as: Tag = 'div', padded = true, className = '', children, ...rest }: CardProps) {
  return (
    <Tag
      className={`rounded-2xl border border-line/[0.08] bg-surface-1 ${padded ? 'p-6' : ''} ${className}`}
      {...rest}
    >
      {children}
    </Tag>
  )
}

export function CardHeader({
  title,
  description,
  action,
  id
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
  id?: string
}) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 id={id} className="text-[15px] font-semibold tracking-tightish text-ink">
          {title}
        </h2>
        {description ? <p className="mt-1 text-[13px] leading-5 text-ink-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  )
}
