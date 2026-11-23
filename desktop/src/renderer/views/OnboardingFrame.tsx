import type { ReactNode } from 'react'

/** Calm, centred full-window layout shared by Sign in, Paywall, Starting and errors. */
export function OnboardingFrame({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-canvas">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-[-20%] h-[640px] w-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(var(--accent)/0.20),transparent)] blur-2xl" />
        <div className="map-backdrop absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black,transparent_70%)]" />
      </div>
      <div className="app-drag h-10 shrink-0" />
      <main id="content" className="relative z-10 flex flex-1 items-center justify-center overflow-y-auto px-6 pb-12">
        <div className={`w-full ${wide ? 'max-w-[880px]' : 'max-w-[440px]'} animate-enter`}>{children}</div>
      </main>
    </div>
  )
}
