import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import type { Node } from '../../shared/types'
import { api, errorText } from '../lib/api'
import { formatBytes, osLabel, relativeTime } from '../lib/format'
import { Button } from './Button'
import { DeviceGlyph } from './DeviceGlyph'
import { AlertIcon, CloseIcon, CodeIcon, SendIcon } from './Icons'
import { StatusDot } from './StatusDot'
import { useToast } from './Toast'

// Phase-1 limits (airbridge_app/security.py).
const MAX_TASK_BYTES = 64_000
const MAX_CODE_BYTES = 512_000

const bytesOf = (s: string) => new TextEncoder().encode(s).length

/** Turn backend / IPC errors into something a non-engineer can act on. */
export function friendlySendError(raw: string, target: string): string {
  const s = raw.toLowerCase()
  if (/413|too large|payload|limit/.test(s)) return 'That’s a little too big to send. Try trimming the code.'
  if (/429|rate|too many/.test(s)) return 'You’re sending quickly — wait a few seconds and try again.'
  if (/401|403|secret|forbidden|unauthori/.test(s))
    return `${target} said no. Make sure both computers use the same AirBridge settings.`
  if (/not found|unknown|no such|resolve/.test(s))
    return `We can’t find ${target} on your network any more. Check it’s signed in to Tailscale.`
  if (/timeout|timed out|unreach|refused|502|connect|offline/.test(s))
    return `Couldn’t reach ${target} — is it awake and running AirBridge?`
  return raw || 'Something went wrong. Please try again.'
}

export function SendTaskSheet({
  open,
  onClose,
  nodes,
  initialTarget
}: {
  open: boolean
  onClose: () => void
  nodes: Node[]
  initialTarget?: string | null
}) {
  const toast = useToast()
  const titleId = useId()
  const descId = useId()
  const errId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const taskRef = useRef<HTMLTextAreaElement>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)

  const sorted = useMemo(
    () => [...nodes].sort((a, b) => Number(b.online) - Number(a.online) || a.hostname.localeCompare(b.hostname)),
    [nodes]
  )
  const firstOnline = sorted.find((n) => n.online)?.hostname ?? ''

  const [target, setTarget] = useState('')
  const [task, setTask] = useState('')
  const [code, setCode] = useState('')
  const [showCode, setShowCode] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    restoreFocus.current = document.activeElement as HTMLElement | null
    const pre = initialTarget && sorted.some((n) => n.hostname === initialTarget && n.online) ? initialTarget : firstOnline
    setTarget(pre)
    setError(null)
    setSending(false)
    const t = window.setTimeout(() => taskRef.current?.focus(), 30)
    return () => {
      window.clearTimeout(t)
      restoreFocus.current?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !panelRef.current) return
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (!focusables.length) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const taskBytes = bytesOf(task)
  const codeBytes = bytesOf(code)
  const tooBig = taskBytes > MAX_TASK_BYTES || codeBytes > MAX_CODE_BYTES
  const canSend = !!target && task.trim().length > 0 && !tooBig && !sending

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!target) return setError('Pick a computer to send to.')
    if (!task.trim()) return setError('Describe what you’d like it to do.')
    if (tooBig) return setError('That’s a little too big to send. Try trimming the code.')
    setSending(true)
    setError(null)
    try {
      const res = await api().backend.sendTask({
        target_hostname: target,
        task_description: task.trim(),
        ...(showCode && code.trim() ? { code_payload: code } : {})
      })
      if (res.ok) {
        toast.show({ tone: 'success', title: `Sent to ${res.target || target}`, body: 'It’s waiting in their inbox.' })
        setTask('')
        setCode('')
        setShowCode(false)
        onClose()
      } else {
        setError(friendlySendError(res.error, target))
      }
    } catch (err) {
      setError(friendlySendError(errorText(err), target))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/50 animate-fade-in" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="relative m-3 flex w-[440px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-2xl border border-line/10 bg-surface-1 shadow-overlay animate-sheet-in"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line/[0.06] px-6 pb-4 pt-5">
          <div>
            <h2 id={titleId} className="text-[17px] font-semibold tracking-tightish">
              Send a task
            </h2>
            <p id={descId} className="mt-1 text-[13px] text-ink-muted">
              The other computer’s AI app will find it in its inbox.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-2 rounded-lg p-1.5 text-ink-faint hover:bg-line/[0.06] hover:text-ink"
          >
            <CloseIcon size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col" noValidate>
          <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
            <fieldset>
              <legend className="mb-2 text-[13px] font-medium text-ink">Send to</legend>
              {sorted.length === 0 ? (
                <p className="rounded-xl bg-surface-2 px-4 py-3 text-[13px] text-ink-muted">
                  No other computers yet. Add one from the Devices page.
                </p>
              ) : (
                <div className="space-y-2">
                  {sorted.map((n) => {
                    const checked = target === n.hostname
                    return (
                      <label
                        key={n.hostname}
                        className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 transition duration-150 ease-calm has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-ink ${
                          !n.online ? 'cursor-not-allowed opacity-60' : ''
                        } ${checked ? 'border-ink/40 bg-surface-3' : 'border-line/[0.08] bg-surface-2 hover:border-line/15'}`}
                      >
                        <input
                          type="radio"
                          name="target"
                          value={n.hostname}
                          checked={checked}
                          disabled={!n.online}
                          onChange={() => setTarget(n.hostname)}
                          className="sr-only"
                        />
                        <DeviceGlyph os={n.os} hostname={n.hostname} size={18} className="h-8 w-8 rounded-lg" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[14px] font-medium text-ink">{n.hostname}</span>
                          <span className="block text-[12px] text-ink-faint">
                            {osLabel(n.os)}
                            {!n.online ? ` · last seen ${relativeTime(n.last_seen)}` : ''}
                          </span>
                        </span>
                        <StatusDot status={n.online ? 'online' : 'offline'} />
                        <span
                          aria-hidden="true"
                          className={`grid h-4 w-4 place-items-center rounded-full border ${checked ? 'border-ink bg-ink' : 'border-line/25'}`}
                        >
                          {checked ? <span className="h-1.5 w-1.5 rounded-full bg-canvas" /> : null}
                        </span>
                      </label>
                    )
                  })}
                </div>
              )}
            </fieldset>

            <div>
              <label htmlFor="task-text" className="mb-2 block text-[13px] font-medium text-ink">
                What should it do?
              </label>
              <textarea
                id="task-text"
                ref={taskRef}
                value={task}
                onChange={(e) => setTask(e.target.value)}
                rows={4}
                required
                aria-invalid={taskBytes > MAX_TASK_BYTES || undefined}
                aria-describedby={error ? errId : undefined}
                placeholder="e.g. Run the test suite and fix anything that fails"
                className="block w-full resize-y rounded-xl border border-line/10 bg-surface-2 px-3.5 py-3 text-[14px] leading-6 text-ink placeholder:text-ink-faint focus-visible:border-line/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ink/50"
              />
            </div>

            <div>
              {!showCode ? (
                <Button variant="ghost" size="sm" icon={<CodeIcon size={16} />} onClick={() => setShowCode(true)} className="-ml-2">
                  Add code (optional)
                </Button>
              ) : (
                <>
                  <div className="mb-2 flex items-baseline justify-between">
                    <label htmlFor="task-code" className="text-[13px] font-medium text-ink">
                      Code <span className="font-normal text-ink-faint">(optional)</span>
                    </label>
                    <span className={`text-[12px] tabular-nums ${codeBytes > MAX_CODE_BYTES ? 'text-danger' : 'text-ink-faint'}`}>
                      {formatBytes(codeBytes)} of {formatBytes(MAX_CODE_BYTES)}
                    </span>
                  </div>
                  <textarea
                    id="task-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    rows={7}
                    spellCheck={false}
                    aria-invalid={codeBytes > MAX_CODE_BYTES || undefined}
                    placeholder="Paste a snippet, a diff or a file"
                    className="block w-full resize-y rounded-xl border border-line/10 bg-canvas px-3.5 py-3 font-mono text-[12.5px] leading-5 text-ink placeholder:text-ink-faint focus-visible:border-line/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ink/50"
                  />
                </>
              )}
            </div>

            {error ? (
              <div
                id={errId}
                role="alert"
                className="flex items-start gap-3 rounded-xl border border-danger/25 bg-danger/10 px-4 py-3 text-[13px] leading-5 text-ink"
              >
                <AlertIcon size={16} className="mt-0.5 shrink-0 text-danger" />
                <span>{error}</span>
              </div>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-line/[0.06] px-6 py-4">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={sending} disabled={!canSend} icon={<SendIcon size={16} />}>
              {sending ? 'Sending…' : target ? `Send to ${target}` : 'Send'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
