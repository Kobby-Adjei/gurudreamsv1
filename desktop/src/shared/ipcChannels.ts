/** IPC channel names (frozen contract, PHASE2_PLAN.md §2 + PHASE3_PLAN.md §2 "IPC additions"). */

/** Renderer → main (ipcRenderer.invoke / ipcMain.handle). */
export const INVOKE = {
  authGet: 'ab:auth:get',
  authSignIn: 'ab:auth:signin',
  authSignOut: 'ab:auth:signout',
  licenseGet: 'ab:license:get',
  licenseRefresh: 'ab:license:refresh',
  licenseCheckout: 'ab:license:checkout',
  backendStatus: 'ab:backend:status',
  backendLifecycle: 'ab:backend:lifecycle',
  backendNodes: 'ab:backend:nodes',
  backendEvents: 'ab:backend:events',
  backendSend: 'ab:backend:send',
  settingsMcp: 'ab:settings:mcp',
  settingsCopy: 'ab:settings:copy',
  networkStatus: 'ab:network:status',
  networkRetry: 'ab:network:retry',
} as const;

/** Main → renderer (webContents.send / ipcRenderer.on). */
export const PUSH = {
  authChanged: 'ab:auth:changed',
  licenseChanged: 'ab:license:changed',
  backendEvent: 'ab:backend:event',
  backendStatus: 'ab:backend:status',
  backendLifecycle: 'ab:backend:lifecycle',
  networkChanged: 'ab:network:changed',
} as const;

export type InvokeChannel = (typeof INVOKE)[keyof typeof INVOKE];
export type PushChannel = (typeof PUSH)[keyof typeof PUSH];

export const INVOKE_CHANNELS: readonly InvokeChannel[] = Object.values(INVOKE);
export const PUSH_CHANNELS: readonly PushChannel[] = Object.values(PUSH);
