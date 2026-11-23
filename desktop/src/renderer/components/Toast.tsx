import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertIcon, CheckIcon, CloseIcon, InfoIcon } from './Icons'

type ToastTone = 'success' | 'error' | 'info'
interface ToastItem {
  id: number
  tone: ToastTone
  title: string
  body?: string
}
interface ToastApi {
  show: (t: Omit<ToastItem, 'id'>) => void
}

const ToastContext = createContext<ToastApi>({ show: () => undefined })

export function useToast(): ToastApi {
  return useContext(ToastContext)
}

const TOAST_MS = 4500

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), [])
  const show = useCallback(
    (t: Omit<ToastItem, 'id'>) => {
      const id = nextId.current++
      setItems((xs) => [...xs.slice(-2), { ...t, id }])
      window.setTimeout(() => dismiss(id), TOAST_MS)
    },
    [dismiss]
  )
  const value = useMemo(() => ({ show }), [show])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="region"
        aria-label="Notifications"
        className="pointer-events-none fixed bottom-6 right-6 z-50 flex w-[360px] max-w-[calc(100vw-48px)] flex-col gap-3"
      >
        <div aria-live="polite" className="contents">
          {items.map((t) => (
            <div
              key={t.id}
              role={t.tone === 'error' ? 'alert' : 'status'}
              className="pointer-events-auto flex items-start gap-3 rounded-2xl border border-line/10 bg-surface-2/95 p-4 shadow-lift backdrop-blur-xl animate-enter"
            >
              <span
                className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full ${
                  t.tone === 'success'
                    ? 'bg-ok/15 text-ok'
                    : t.tone === 'error'
                      ? 'bg-danger/15 text-danger'
                      : 'bg-accent/15 text-accent-ink'
                }`}
              >
                {t.tone === 'success' ? (
                  <CheckIcon size={14} />
                ) : t.tone === 'error' ? (
                  <AlertIcon size={14} />
                ) : (
                  <InfoIcon size={14} />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-ink">{t.title}</p>
                {t.body ? <p className="mt-0.5 text-[13px] leading-5 text-ink-muted">{t.body}</p> : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="-m-1 rounded-lg p-1 text-ink-faint hover:bg-line/[0.06] hover:text-ink"
                aria-label="Dismiss notification"
              >
                <CloseIcon size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  )
}
