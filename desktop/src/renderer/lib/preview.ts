import type { AuthState, LicenseStatus } from '../../shared/types'

/**
 * Preview mode (PHASE3_PLAN.md §8): licensing is wired but not enforced until
 * the app is approved. Main reports this as `LicenseStatus.enforced === false`.
 *
 * `enforced` is read as optional so the renderer compiles against either
 * shape of shared/types.ts; a missing value always means "enforced" (safe).
 */
export type LicenseView = Omit<LicenseStatus, 'enforced'> & { enforced?: boolean }

export function isEnforced(license: LicenseView | null | undefined): boolean {
  return license?.enforced !== false
}

/** True only when main has told us, explicitly, that nothing is gated. */
export function isPreview(license: LicenseView | null | undefined): boolean {
  return !!license && license.enforced === false
}

/**
 * Preview + signed out: the app opens as usual, but the private network waits
 * for a sign-in (main reports `needs_login`). The UI asks for that sign-in in
 * place, never with a wall. Enforced mode has its own full-window sign-in.
 */
export function needsSignIn(
  license: LicenseView | null | undefined,
  auth: AuthState | null | undefined
): boolean {
  return isPreview(license) && auth?.state !== 'signed_in'
}

export const PREVIEW_NOTE = 'AirBridge is in preview — everything is unlocked while we test.'
