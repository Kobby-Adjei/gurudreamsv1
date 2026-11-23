/**
 * Shared types between main, preload and renderer (frozen contract, PHASE2_PLAN.md §2).
 * Shapes mirror the Python control API (airbridge_app/control.py) and event schema exactly.
 * This file must stay free of runtime imports so every process can use it.
 */

/** GET /status */
export interface BackendStatus {
  version: string;
  mode: 'daemon';
  tailnet_ip: string | null;
  inbox: {
    listening: boolean;
    port: number; // 8989
    degraded_reason: string | null;
  };
  uptime_s: number;
}

export interface Node {
  hostname: string;
  ip: string;
  os: string;
  online: boolean;
  last_seen: string | null;
}

/** GET /nodes */
export interface NodesResponse {
  self: { hostname: string; ip: string; os: string };
  nodes: Node[];
  error: string | null;
}

export type AirEventType =
  | 'task_received'
  | 'task_sent'
  | 'send_failed'
  | 'node_online'
  | 'node_offline'
  | 'inbox_listening'
  | 'inbox_degraded'
  | 'daemon_started'
  | 'daemon_stopping';

export const AIR_EVENT_TYPES: readonly AirEventType[] = [
  'task_received',
  'task_sent',
  'send_failed',
  'node_online',
  'node_offline',
  'inbox_listening',
  'inbox_degraded',
  'daemon_started',
  'daemon_stopping',
] as const;

/** Event (JSONL v1) */
export interface AirEvent {
  v: 1;
  id: string; // uuid4
  ts: string; // ISO8601 Z
  type: AirEventType;
  origin: 'daemon' | 'mcp';
  local_node: string;
  peer: string | null;
  summary: string; // ≤120 chars, neutralized
  detail: { bytes?: number; file?: string; error?: string };
}

/** POST /send_task body */
export interface SendTaskRequest {
  target_hostname: string;
  task_description: string;
  code_payload?: string;
}

/** POST /send_task response */
export type SendTaskResult =
  | { ok: true; file: string; target: string }
  | { ok: false; error: string };

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
}

export interface AuthState {
  state: 'signed_out' | 'signing_in' | 'signed_in';
  user?: AuthUser;
}

export interface LicenseStatus {
  state: 'valid' | 'grace' | 'inactive' | 'unknown';
  plan: string | null;
  exp: number | null; // unix seconds
}

export interface BackendLifecycle {
  phase: 'stopped' | 'starting' | 'running' | 'crashed' | 'blocked';
  detail?: string;
}

export type McpClient = 'claude' | 'cursor';

export type Unsubscribe = () => void;

/** window.airbridge (frozen surface, exposed by src/preload/index.ts) */
export interface AirbridgeApi {
  auth: {
    getState(): Promise<AuthState>;
    signIn(): Promise<void>;
    signOut(): Promise<void>;
    onChange(cb: (state: AuthState) => void): Unsubscribe;
  };
  license: {
    getStatus(): Promise<LicenseStatus>;
    refresh(): Promise<LicenseStatus>;
    openCheckout(): Promise<void>;
    onChange(cb: (status: LicenseStatus) => void): Unsubscribe;
  };
  backend: {
    getStatus(): Promise<BackendStatus | null>;
    getLifecycle(): Promise<BackendLifecycle>;
    getNodes(): Promise<NodesResponse | null>;
    getEvents(limit: number): Promise<AirEvent[]>;
    sendTask(req: SendTaskRequest): Promise<SendTaskResult>;
    onEvent(cb: (event: AirEvent) => void): Unsubscribe;
    onStatus(cb: (status: BackendStatus) => void): Unsubscribe;
    onLifecycle(cb: (lifecycle: BackendLifecycle) => void): Unsubscribe;
  };
  settings: {
    getMcpConfig(client: McpClient): Promise<{ json: string }>;
    copyMcpConfig(client: McpClient): Promise<void>;
  };
  app: {
    version: string;
    platform: string;
  };
}

declare global {
  interface Window {
    airbridge: AirbridgeApi;
  }
}
