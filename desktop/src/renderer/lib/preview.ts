import type { AuthState, LicenseStatus } from '../../shared/types'
import type { NetStatus } from './network'

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
 * Which network the background service is using.
 * - `embedded`: AirBridge's own private network (the designed path).
 * - `system`: preview only, the computer's existing setup (no sign-in or no servers).
 *
 * Main may say so via `NetStatus.mode`; without it we infer from the plan's rule:
 * in preview, embedded needs a signed-in account.
 */
export type NetMode = 'embedded' | 'system'

export function networkMode(
  license: LicenseView | null | undefined,
  auth: AuthState | null | undefined,
  network: NetStatus | null | undefined
): NetMode {
  if (!isPreview(license)) return 'embedded'
  if (network?.mode) return network.mode
  return auth?.state === 'signed_in' ? 'embedded' : 'system'
}

/**
 * The single place the renderer may name the network vendor: shown only in
 * preview + system mode when the network or service reports trouble.
 * Allowlisted, by exact line, in tests/renderer/copy.test.ts.
 */
export const SYSTEM_NETWORK_HINT = 'Make sure Tailscale is running on this computer.'

export const PREVIEW_NOTE = 'AirBridge is in preview — everything is unlocked while we test.'
