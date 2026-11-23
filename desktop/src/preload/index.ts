/**
 * Preload (sandboxed, contextIsolation). Exposes exactly the frozen `window.airbridge` surface
 * (PHASE2_PLAN.md §2) — never raw ipcRenderer, never Electron event objects.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { INVOKE, PUSH, type PushChannel } from '../shared/ipcChannels';
import type {
  AirbridgeApi,
  AirEvent,
  AuthState,
  BackendLifecycle,
  BackendStatus,
  LicenseStatus,
  McpClient,
  NodesResponse,
  SendTaskRequest,
  SendTaskResult,
} from '../shared/types';

function subscribe<T>(channel: PushChannel, cb: (payload: T) => void): () => void {
  if (typeof cb !== 'function') throw new TypeError('callback must be a function');
  const listener = (_event: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    ipcRenderer.removeListener(channel, listener);
  };
}

/** Main passes `--airbridge-app-version=<semver>` via webPreferences.additionalArguments. */
function appVersion(): string {
  const prefix = '--airbridge-app-version=';
  const arg = (process.argv ?? []).find((a) => typeof a === 'string' && a.startsWith(prefix));
  const v = arg?.slice(prefix.length) ?? '';
  return /^[0-9A-Za-z.+-]{1,32}$/.test(v) ? v : '0.0.0';
}

export const api: AirbridgeApi = {
  auth: {
    getState: () => ipcRenderer.invoke(INVOKE.authGet) as Promise<AuthState>,
    signIn: () => ipcRenderer.invoke(INVOKE.authSignIn) as Promise<void>,
    signOut: () => ipcRenderer.invoke(INVOKE.authSignOut) as Promise<void>,
    onChange: (cb) => subscribe<AuthState>(PUSH.authChanged, cb),
  },
  license: {
    getStatus: () => ipcRenderer.invoke(INVOKE.licenseGet) as Promise<LicenseStatus>,
    refresh: () => ipcRenderer.invoke(INVOKE.licenseRefresh) as Promise<LicenseStatus>,
    openCheckout: () => ipcRenderer.invoke(INVOKE.licenseCheckout) as Promise<void>,
  },
  backend: {
    getStatus: () => ipcRenderer.invoke(INVOKE.backendStatus) as Promise<BackendStatus | null>,
    getLifecycle: () => ipcRenderer.invoke(INVOKE.backendLifecycle) as Promise<BackendLifecycle>,
    getNodes: () => ipcRenderer.invoke(INVOKE.backendNodes) as Promise<NodesResponse | null>,
    getEvents: (limit: number) => ipcRenderer.invoke(INVOKE.backendEvents, limit) as Promise<AirEvent[]>,
    sendTask: (req: SendTaskRequest) => ipcRenderer.invoke(INVOKE.backendSend, req) as Promise<SendTaskResult>,
    onEvent: (cb) => subscribe<AirEvent>(PUSH.backendEvent, cb),
    onStatus: (cb) => subscribe<BackendStatus>(PUSH.backendStatus, cb),
    onLifecycle: (cb) => subscribe<BackendLifecycle>(PUSH.backendLifecycle, cb),
  },
  settings: {
    getMcpConfig: (client: McpClient) => ipcRenderer.invoke(INVOKE.settingsMcp, client) as Promise<{ json: string }>,
    copyMcpConfig: (client: McpClient) => ipcRenderer.invoke(INVOKE.settingsCopy, client) as Promise<void>,
  },
  app: {
    version: appVersion(),
    platform: process.platform,
  },
};

contextBridge.exposeInMainWorld('airbridge', api);
