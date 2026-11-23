/**
 * IPC wiring between the renderer (via preload) and the main process.
 *
 * Every handler: (1) checks the sender is a live top-level frame on the app origin
 * (Security's isTrustedSender), (2) validates the payload shape, (3) never returns secrets
 * (no Clerk tokens, no control token) and never forwards internal error messages.
 */
import { clipboard as electronClipboard, ipcMain as electronIpcMain } from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { INVOKE, PUSH, type PushChannel } from '../shared/ipcChannels';
import type {
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
import { isTrustedSender } from './security';

// Phase-1 limits (airbridge_app/security.py)
export const MAX_TASK_BYTES = 64_000;
export const MAX_CODE_BYTES = 512_000;
export const MAX_EVENTS_LIMIT = 1000;
const HOSTNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MCP_CLIENTS: readonly McpClient[] = ['claude', 'cursor'];

export class IpcForbiddenError extends Error {
  constructor() {
    super('forbidden');
    this.name = 'IpcForbiddenError';
  }
}
export class IpcValidationError extends Error {
  constructor(what: string) {
    super(`invalid_payload: ${what}`);
    this.name = 'IpcValidationError';
  }
}

export interface IpcDeps {
  /** From Security's appOriginFor(); dev server origin or file:// renderer dir. */
  allowedOrigin: string | readonly string[];
  auth: {
    getState(): AuthState;
    signIn(): Promise<void>;
    signOut(): Promise<void>;
  };
  license: {
    getStatus(): LicenseStatus;
    refresh(): Promise<LicenseStatus>;
    openCheckout(): Promise<void>;
  };
  backend: {
    getStatus(): Promise<BackendStatus | null>;
    getLifecycle(): BackendLifecycle;
    getNodes(): Promise<NodesResponse | null>;
    getEvents(limit: number): Promise<AirEvent[]>;
    sendTask(req: SendTaskRequest): Promise<SendTaskResult>;
  };
  /** Returns the JSON config text for the client (see mcpConfig.ts getMcpConfigJson). */
  getMcpConfigJson(client: McpClient): string;
  /** Window to push events to (null when no window). */
  getWebContents(): WebContents | null;
  /** Injected in tests; default electron.ipcMain / electron.clipboard. */
  ipcMain?: Pick<typeof electronIpcMain, 'handle' | 'removeHandler'>;
  clipboard?: Pick<typeof electronClipboard, 'writeText'>;
  log?: (msg: string, err?: unknown) => void;
}

export interface IpcHandle {
  push: {
    authChanged(state: AuthState): void;
    licenseChanged(status: LicenseStatus): void;
    backendEvent(event: AirEvent): void;
    backendStatus(status: BackendStatus): void;
    backendLifecycle(lifecycle: BackendLifecycle): void;
  };
  dispose(): void;
}

// ------------------------------------------------------------------ validators

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function noArgs(args: unknown[]): void {
  if (args.length !== 0) throw new IpcValidationError('unexpected arguments');
}

export function validateLimit(args: unknown[]): number {
  if (args.length !== 1) throw new IpcValidationError('limit');
  const n = args[0];
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_EVENTS_LIMIT) {
    throw new IpcValidationError('limit');
  }
  return n;
}

export function validateMcpClient(args: unknown[]): McpClient {
  if (args.length !== 1 || !MCP_CLIENTS.includes(args[0] as McpClient)) throw new IpcValidationError('client');
  return args[0] as McpClient;
}

export function validateSendTask(args: unknown[]): SendTaskRequest {
  if (args.length !== 1) throw new IpcValidationError('request');
  const r = args[0];
  if (!r || typeof r !== 'object' || Array.isArray(r) || Object.getPrototypeOf(r) !== Object.prototype) {
    throw new IpcValidationError('request');
  }
  const o = r as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (k !== 'target_hostname' && k !== 'task_description' && k !== 'code_payload') {
      throw new IpcValidationError(`unknown field ${k.slice(0, 32)}`);
    }
  }
  if (typeof o.target_hostname !== 'string' || !HOSTNAME_RE.test(o.target_hostname)) {
    throw new IpcValidationError('target_hostname');
  }
  if (
    typeof o.task_description !== 'string' ||
    o.task_description.trim().length === 0 ||
    byteLength(o.task_description) > MAX_TASK_BYTES
  ) {
    throw new IpcValidationError('task_description');
  }
  const out: SendTaskRequest = { target_hostname: o.target_hostname, task_description: o.task_description };
  if (o.code_payload !== undefined && o.code_payload !== null) {
    if (typeof o.code_payload !== 'string' || byteLength(o.code_payload) > MAX_CODE_BYTES) {
      throw new IpcValidationError('code_payload');
    }
    if (o.code_payload.length > 0) out.code_payload = o.code_payload;
  }
  return out;
}

// ------------------------------------------------------------------ registration

export function registerIpc(deps: IpcDeps): IpcHandle {
  const ipc = deps.ipcMain ?? electronIpcMain;
  const clip = deps.clipboard ?? electronClipboard;
  const log = deps.log ?? ((msg: string, err?: unknown) => console.error(`[ipc] ${msg}`, err instanceof Error ? err.message : ''));
  const channels: string[] = [];

  const handle = <T>(channel: string, fn: (args: unknown[]) => Promise<T> | T) => {
    channels.push(channel);
    ipc.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!isTrustedSender(event, deps.allowedOrigin)) {
        log(`rejected ${channel} from untrusted frame`);
        throw new IpcForbiddenError();
      }
      return fn(args);
    });
  };

  /** Run a dep call; on failure log internally and return a safe fallback / generic error. */
  const safe = async <T>(what: string, fn: () => Promise<T> | T, fallback?: () => T): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      log(`${what} failed`, e);
      if (fallback) return fallback();
      throw new Error(`${what}_failed`);
    }
  };

  handle(INVOKE.authGet, (a) => (noArgs(a), deps.auth.getState()));
  handle(INVOKE.authSignIn, (a) => (noArgs(a), safe('signin', () => deps.auth.signIn())));
  handle(INVOKE.authSignOut, (a) => (noArgs(a), safe('signout', () => deps.auth.signOut())));

  handle(INVOKE.licenseGet, (a) => (noArgs(a), deps.license.getStatus()));
  handle(INVOKE.licenseRefresh, (a) => (noArgs(a), safe('license_refresh', () => deps.license.refresh(), () => deps.license.getStatus())));
  handle(INVOKE.licenseCheckout, (a) => (noArgs(a), safe('checkout', () => deps.license.openCheckout())));

  handle(INVOKE.backendStatus, (a) => (noArgs(a), safe('status', () => deps.backend.getStatus(), () => null)));
  handle(INVOKE.backendLifecycle, (a) => (noArgs(a), deps.backend.getLifecycle()));
  handle(INVOKE.backendNodes, (a) => (noArgs(a), safe('nodes', () => deps.backend.getNodes(), () => null)));
  handle(INVOKE.backendEvents, (a) => {
    const limit = validateLimit(a);
    return safe('events', () => deps.backend.getEvents(limit), () => [] as AirEvent[]);
  });
  handle(INVOKE.backendSend, (a) => {
    const req = validateSendTask(a);
    return safe<SendTaskResult>('send', () => deps.backend.sendTask(req), () => ({ ok: false, error: 'Backend is not running.' }));
  });

  handle(INVOKE.settingsMcp, (a) => {
    const client = validateMcpClient(a);
    return { json: deps.getMcpConfigJson(client) };
  });
  handle(INVOKE.settingsCopy, (a) => {
    const client = validateMcpClient(a);
    clip.writeText(deps.getMcpConfigJson(client));
  });

  const send = (channel: PushChannel, payload: unknown) => {
    const wc = deps.getWebContents();
    if (!wc || wc.isDestroyed()) return;
    if (!isTrustedSender({ senderFrame: wc.mainFrame as never }, deps.allowedOrigin)) return; // never push to a foreign page
    wc.send(channel, payload);
  };

  return {
    push: {
      authChanged: (s) => send(PUSH.authChanged, s),
      licenseChanged: (s) => send(PUSH.licenseChanged, s),
      backendEvent: (e) => send(PUSH.backendEvent, e),
      backendStatus: (s) => send(PUSH.backendStatus, s),
      backendLifecycle: (l) => send(PUSH.backendLifecycle, l),
    },
    dispose() {
      for (const c of channels) ipc.removeHandler(c);
      channels.length = 0;
    },
  };
}
