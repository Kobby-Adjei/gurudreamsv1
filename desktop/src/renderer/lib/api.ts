import type { AirbridgeApi } from '../../shared/types'

/**
 * The preload bridge. The renderer never talks to the daemon, Clerk or the
 * licence server directly – everything goes through this frozen surface.
 */
export function api(): AirbridgeApi {
  const bridge = (window as Window & { airbridge?: AirbridgeApi }).airbridge
  if (!bridge) {
    throw new Error('AirBridge bridge unavailable (window.airbridge missing)')
  }
  return bridge
}

/** Best-effort: turn anything thrown across IPC into a short readable string. */
export function errorText(err: unknown): string {
  if (err instanceof Error) {
    // Electron prefixes remote errors with "Error invoking remote method '…': Error: "
    return err.message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
  }
  if (typeof err === 'string') return err
  return 'Something went wrong.'
}
