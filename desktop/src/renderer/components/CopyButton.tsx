import { useEffect, useRef, useState } from 'react'
import { Button, type ButtonSize, type ButtonVariant } from './Button'
import { CheckIcon, CopyIcon } from './Icons'

type CopyState = 'idle' | 'copying' | 'copied' | 'error'

/**
 * Copies via the provided async action (e.g. settings.copyMcpConfig, which
 * uses Electron's clipboard in main) and confirms with "✓ Copied".
 * The confirmation is announced through a polite live region.
 */
export function CopyButton({
  onCopy,
  label = 'Copy',
  copiedLabel = 'Copied',
  variant = 'primary',
  size = 'md',
  className = '',
  describedBy
}: {
  onCopy: () => Promise<unknown>
  label?: string
  copiedLabel?: string
  variant?: ButtonVariant
  size?: ButtonSize
  className?: string
  describedBy?: string
}) {
  const [state, setState] = useState<CopyState>('idle')
  const timer = useRef<number>()

  useEffect(() => () => window.clearTimeout(timer.current), [])

  async function handle() {
    window.clearTimeout(timer.current)
    setState('copying')
    try {
      await onCopy()
      setState('copied')
    } catch {
      setState('error')
    }
    timer.current = window.setTimeout(() => setState('idle'), 2200)
  }

  const copied = state === 'copied'
  return (
    <>
      <Button
        variant={variant}
        size={size}
        onClick={handle}
        disabled={state === 'copying'}
        aria-describedby={describedBy}
        className={`${copied ? '!border !border-line/10 !bg-surface-2 !text-ok' : ''} min-w-[7.5rem] ${className}`}
        icon={copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
      >
        {copied ? copiedLabel : state === 'error' ? 'Try again' : label}
      </Button>
      <span className="sr-only" aria-live="polite" role="status">
        {copied ? 'Copied to clipboard' : state === 'error' ? 'Copy failed. Try again.' : ''}
      </span>
    </>
  )
}
