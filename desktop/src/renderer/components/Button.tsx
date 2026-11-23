import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Spinner } from './Spinner'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
  trailingIcon?: ReactNode
  loading?: boolean
  block?: boolean
}

const base =
  'app-no-drag relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-xl font-medium tracking-tightish transition duration-150 ease-calm disabled:cursor-not-allowed disabled:opacity-50 active:scale-[0.98] motion-reduce:active:scale-100'

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover disabled:hover:bg-accent',
  secondary: 'bg-surface-2 text-ink border border-line/10 hover:bg-surface-3 hover:border-line/15',
  ghost: 'text-ink-muted hover:bg-line/[0.06] hover:text-ink',
  danger: 'bg-surface-2 text-danger border border-line/10 hover:bg-surface-3'
}

const sizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-6 text-[15px]'
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    icon,
    trailingIcon,
    loading = false,
    block = false,
    className = '',
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`${base} ${variants[variant]} ${sizes[size]} ${block ? 'w-full' : ''} ${className}`}
      {...rest}
    >
      {loading ? <Spinner size={16} /> : icon}
      {children}
      {trailingIcon}
    </button>
  )
})
