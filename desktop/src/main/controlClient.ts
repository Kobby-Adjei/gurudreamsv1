/**
 * Main-process client for the daemon's local control API (127.0.0.1 only).
 *
 * HTTP via fetch with `Authorization: Bearer <token>`; Node's fetch sends Host=127.0.0.1:<port>
 * and no Origin header, which is exactly what the daemon's guard requires.
 * Live events via WebSocket `/events/stream` using the `ws` package (Node 22's global WebSocket
 * cannot set request headers), reconnecting with exponential backoff.
 *
 * The token lives only here and in processManager; nothing in this module is exposed to the
 * renderer except parsed, validated response bodies.
 */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { AirEvent, BackendStatus, NodesResponse, SendTaskRequest, SendTaskResult } from '../shared/types';
import { AIR_EVENT_TYPES } from '../shared/types';

export const CONTROL_HOST = '127.0.0.1';
const REQUEST_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 30_000;
const STATUS_POLL_MS = 5_000;
const WS_MAX_PAYLOAD = 64 * 1024;

export interface ControlConnection {
  port: number;
  token: string;
}

/** Minimal surface of `ws` used here (lets tests inject a fake). */
export interface WsLike {
  on(event: 'open', cb: () => void): unknown;
  on(event: 'message', cb: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close', cb: (code: number, reason: Buffer) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  close(code?: number): void;
  terminate?(): void;
}
export type WsFactory = (url: string, headers: Record<string, string>) => WsLike;

export interface ControlClientOptions {
  fetch?: typeof fetch;
  wsFactory?: WsFactory;
  statusPollMs?: number;
  /** Reconnect delay for attempt n (1-based). Default 0.5s doubling, capped at 15s. */
  reconnectDelayMs?: (attempt: number) => number;
  log?: (msg: string) => void;
}

export interface ControlClientEvents {
  event: [AirEvent];
  status: [BackendStatus];
  connected: [boolean];
}

export class ControlError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ControlError';
  }
}

const defaultWsFactory: WsFactory = (url, headers) =>
  new WebSocket(url, { headers, maxPayload: WS_MAX_PAYLOAD, handshakeTimeout: REQUEST_TIMEOUT_MS }) as unknown as WsLike;

export function defaultReconnectDelayMs(attempt: number): number {
  return Math.min(15_000, 500 * 2 ** Math.max(0, attempt - 1));
}

const EVENT_TYPES = new Set<string>(AIR_EVENT_TYPES);

/** Structural validation of an event coming off the wire. */
export function isAirEvent(x: unknown): x is AirEvent {
  if (!x || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  return (
    e.v === 1 &&
    typeof e.id === 'string' &&
    e.id.length <= 64 &&
    typeof e.ts === 'string' &&
    typeof e.type === 'string' &&
    EVENT_TYPES.has(e.type) &&
    (e.origin === 'daemon' || e.origin === 'mcp') &&
    typeof e.local_node === 'string' &&
    (e.peer === null || typeof e.peer === 'string') &&
    typeof e.summary === 'string' &&
    e.summary.length <= 200 &&
    !!e.detail &&
    typeof e.detail === 'object'
  );
}

export class ControlClient extends EventEmitter<ControlClientEvents> {
  private conn: ControlConnection | null = null;
  private ws: WsLike | null = null;
  private wsAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private lastStatusJson = '';
  private generation = 0;
  private readonly fetchFn: typeof fetch;
  private readonly wsFactory: WsFactory;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: ControlClientOptions = {}) {
    super();
    this.fetchFn = opts.fetch ?? ((...a) => fetch(...a));
    this.wsFactory = opts.wsFactory ?? defaultWsFactory;
    this.log = opts.log ?? ((m) => console.error(`[control] ${m}`));
  }

  isConnected(): boolean {
    return this.conn !== null;
  }

  /** Point the client at a (re)started daemon and open the event stream. */
  connect(conn: ControlConnection): void {
    if (!Number.isInteger(conn.port) || conn.port < 1 || conn.port > 65535) throw new Error('bad port');
    if (typeof conn.token !== 'string' || conn.token.length < 32) throw new Error('bad token');
    this.disconnect();
    this.conn = { ...conn };
    this.generation += 1;
    this.wsAttempt = 0;
    this.openStream(this.generation);
    const poll = this.opts.statusPollMs ?? STATUS_POLL_MS;
    if (poll > 0) {
      void this.pollStatus();
      this.statusTimer = setInterval(() => void this.pollStatus(), poll);
      this.statusTimer.unref?.();
    }
    this.emit('connected', true);
  }

  /** Drop the connection (daemon stopped). Safe to call repeatedly. */
  disconnect(): void {
    const had = this.conn !== null;
    this.generation += 1;
    this.conn = null;
    this.lastStatusJson = '';
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.reconnectTimer = null;
    this.statusTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000);
      } catch {
        /* ignore */
      }
    }
    if (had) this.emit('connected', false);
  }

  // ------------------------------------------------------------------ HTTP

  private base(): string {
    if (!this.conn) throw new ControlError('backend not running');
    return `http://${CONTROL_HOST}:${this.conn.port}`;
  }

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<{ status: number; body: T }> {
    const conn = this.conn;
    const url = this.base() + path;
    const headers: Record<string, string> = {
      authorization: `Bearer ${conn!.token}`,
      accept: 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    };
    const res = await this.fetchFn(url, {
      ...init,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.status === 401 || res.status === 403) {
      throw new ControlError(`control API refused the request (${res.status})`, res.status);
    }
    return { status: res.status, body: body as T };
  }

  async getStatus(): Promise<BackendStatus> {
    const { status, body } = await this.request<BackendStatus>('/status');
    if (status !== 200 || !body || body.mode !== 'daemon') throw new ControlError(`status failed (${status})`, status);
    return body;
  }

  async getNodes(): Promise<NodesResponse> {
    const { status, body } = await this.request<NodesResponse>('/nodes');
    if (status !== 200 || !body || !Array.isArray(body.nodes)) throw new ControlError(`nodes failed (${status})`, status);
    return body;
  }

  async getEvents(limit = 100, afterId?: string): Promise<AirEvent[]> {
    const n = Math.max(1, Math.min(1000, Math.floor(limit)));
    const qs = new URLSearchParams({ limit: String(n) });
    if (afterId) qs.set('after_id', afterId);
    const { status, body } = await this.request<{ events?: unknown[] }>(`/events?${qs.toString()}`);
    if (status !== 200 || !body || !Array.isArray(body.events)) throw new ControlError(`events failed (${status})`, status);
    return body.events.filter(isAirEvent);
  }

  async sendTask(req: SendTaskRequest): Promise<SendTaskResult> {
    const payload: Record<string, unknown> = {
      target_hostname: req.target_hostname,
      task_description: req.task_description,
    };
    if (req.code_payload !== undefined) payload.code_payload = req.code_payload;
    const { status, body } = await this.request<Record<string, unknown>>(
      '/send_task',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
      SEND_TIMEOUT_MS,
    );
    if (body && body.ok === true && typeof body.file === 'string' && typeof body.target === 'string') {
      return { ok: true, file: body.file, target: body.target };
    }
    const error = body && typeof body.error === 'string' ? body.error : `Send failed (HTTP ${status}).`;
    return { ok: false, error };
  }

  private async pollStatus(): Promise<void> {
    if (!this.conn) return;
    const gen = this.generation;
    try {
      const s = await this.getStatus();
      if (gen !== this.generation) return;
      // uptime changes every poll; only push when something else changed.
      const key = JSON.stringify({ ...s, uptime_s: 0 });
      if (key !== this.lastStatusJson) {
        this.lastStatusJson = key;
        this.emit('status', s);
      }
    } catch (e) {
      if (gen === this.generation) this.log(`status poll failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ------------------------------------------------------------------ WebSocket

  private openStream(gen: number): void {
    if (!this.conn || gen !== this.generation) return;
    const url = `ws://${CONTROL_HOST}:${this.conn.port}/events/stream`;
    let ws: WsLike;
    try {
      ws = this.wsFactory(url, { Authorization: `Bearer ${this.conn.token}` });
    } catch (e) {
      this.log(`event stream connect failed: ${e instanceof Error ? e.message : String(e)}`);
      this.scheduleReconnect(gen);
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      if (gen === this.generation) this.wsAttempt = 0;
    });
    ws.on('message', (data: unknown, isBinary: boolean) => {
      if (gen !== this.generation || isBinary) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof data === 'string' ? data : Buffer.from(data as Buffer).toString('utf8'));
      } catch {
        return;
      }
      if (isAirEvent(parsed)) this.emit('event', parsed);
    });
    ws.on('error', (err: Error) => {
      if (gen === this.generation) this.log(`event stream error: ${err.message}`);
    });
    ws.on('close', (code: number) => {
      if (gen !== this.generation) return;
      this.ws = null;
      if (code === 4401 || code === 4403) {
        this.log(`event stream rejected by daemon (close ${code})`);
      }
      this.scheduleReconnect(gen);
    });
  }

  private scheduleReconnect(gen: number): void {
    if (gen !== this.generation || !this.conn) return;
    this.wsAttempt += 1;
    const delay = (this.opts.reconnectDelayMs ?? defaultReconnectDelayMs)(this.wsAttempt);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openStream(gen);
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
