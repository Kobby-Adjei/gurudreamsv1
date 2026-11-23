/**
 * Supervises the bundled `airbridge-net` sidecar (PHASE3_PLAN.md §9): one Go process embedding
 * tailscale.com/tsnet that joins the customer's Headscale network. No system Tailscale, no tailscaled,
 * no SOCKS proxy, no LocalAPI socket.
 *
 *   start(launch) -> stale cleanup -> 0700 dirs (lstat/owner checked) -> spawn airbridge-net (empty argv,
 *                    scrubbed env, hidden) -> ONE JSON line on stdin {control_url, hostname, control_token,
 *                    state_dir, parent_pid, auth_key?} -> stdin closed -> wait for
 *                    `AIRBRIDGE_NET_READY {"port":N,"pid":P,"host":"::1"|"127.0.0.1"}` on stderr
 *                 -> write <D>/network.json v2 (0600, atomic) -> health `GET /status` every 5 s
 *   crash      -> restart with backoff 1,2,4…30 s WITHOUT the auth key (tsnet keeps its node state);
 *                 5 failures within 2 min -> state 'error'
 *   stop()     -> SIGTERM, SIGKILL after 3 s (Windows: taskkill /PID /T /F)
 *
 * Secrets: the per-spawn control token and the (single-use) pre-auth key only ever travel on the child's
 * stdin. The key is dropped from memory right after that write and is never logged; the sidecar redacts
 * its own logs too (keys, tokens, every URL - including tsnet's interactive login URL).
 */
import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import type { NetStatus } from '../../shared/types';

export const HEALTH_INTERVAL_MS = 5000;
export const STOP_TIMEOUT_MS = 3000;
export const READY_TIMEOUT_MS = 20_000;
export const MAX_FAILURES = 5;
export const FAILURE_WINDOW_MS = 120_000;
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_KEEP = 3;
export const NETWORK_JSON = 'network.json';
export const STATE_DIRNAME = 'tsnet';
export const READY_PREFIX = 'AIRBRIDGE_NET_READY ';
const REQUEST_TIMEOUT_MS = 5000;
const MAX_LINE = 4000;
const MAX_RESPONSE = 1024 * 1024;

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** What to (re)spawn the sidecar with. */
export interface SidecarLaunch {
  /** Headscale URL (login_server from the license server). */
  controlUrl: string;
  /** `airbridge-<[a-z0-9-] ≤50>` (enroll.sanitizeHostname). */
  hostname: string;
  /** Single-use pre-auth key: only when the sidecar reported needs_login. Sent on stdin, then forgotten. */
  authKey?: string;
}

export interface NetManagerOptions {
  /** Directory holding airbridge-net[.exe] (resources/net/<platform>-<arch>). */
  binDir: string;
  /** Shared data dir D (dataDir.ts). */
  dataDir: string;
  platform?: NodeJS.Platform;
  /** Source of the scrubbed allow-listed variables (default: the app's environment). */
  baseEnv?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  log?: (msg: string) => void;
  healthIntervalMs?: number;
  stopTimeoutMs?: number;
  readyTimeoutMs?: number;
  backoffMs?: (attempt: number) => number;
  now?: () => number;
  uid?: number;
  parentPid?: number;
  generateToken?: () => string;
  /** Stale cleanup hooks (tests). */
  isPidAlive?: (pid: number) => boolean;
  processExePath?: (pid: number) => Promise<string | null>;
  killPid?: (pid: number) => Promise<void>;
}

export interface NetManagerEvents {
  status: [NetStatus];
}

interface Endpoint {
  host: '::1' | '127.0.0.1';
  port: number;
  token: string;
  pid: number;
}

export function defaultBackoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

const ENV_ALLOW = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TEMP', 'TMP'];
// Corporate networks: tsnet honours HTTP(S) proxies for the control/DERP connections.
const PROXY_ALLOW = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy'];

/** Allow-listed environment for the sidecar: nothing else from the app (no TS_*, no secrets). */
export function scrubEnv(source: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const names = [...ENV_ALLOW, ...PROXY_ALLOW, ...(platform === 'win32' ? ['SystemRoot'] : [])];
  for (const name of names) {
    const v = source[name];
    if (typeof v === 'string' && v) out[name] = v;
  }
  out.TS_NO_LOGS_NO_SUPPORT = 'true';
  return out;
}

/** Parse one stderr line; `{port,pid,host}` for a valid READY line, else null. */
export function parseNetReady(line: string): { port: number; pid: number; host: '::1' | '127.0.0.1' } | null {
  if (!line.startsWith(READY_PREFIX)) return null;
  try {
    const o = JSON.parse(line.slice(READY_PREFIX.length)) as { port?: unknown; pid?: unknown; host?: unknown };
    if (typeof o.port !== 'number' || !Number.isInteger(o.port) || o.port < 1 || o.port > 65535) return null;
    if (typeof o.pid !== 'number' || !Number.isInteger(o.pid) || o.pid < 1) return null;
    if (o.host !== '::1' && o.host !== '127.0.0.1') return null;
    return { port: o.port, pid: o.pid, host: o.host };
  } catch {
    return null;
  }
}

/** Sidecar GET /status body -> NetStatus (never forwards the sidecar's error text). */
export function parseSidecarStatus(body: unknown): NetStatus {
  const o = (body && typeof body === 'object' ? body : {}) as { state?: unknown; self?: { ip?: unknown } };
  const ip = typeof o.self?.ip === 'string' && /^100\.\d+\.\d+\.\d+$/.test(o.self.ip) ? o.self.ip : undefined;
  switch (o.state) {
    case 'connected':
      return ip ? { state: 'connected', ip } : { state: 'connecting' };
    case 'needs_login':
      return { state: 'needs_login' };
    case 'connecting':
      return { state: 'connecting' };
    case 'error':
      return { state: 'error', detail: 'The private network could not start.' };
    default:
      return { state: 'error', detail: 'Private network returned unreadable status.' };
  }
}

/** F-8: create (or accept) a private directory: real dir, not a symlink, ours, no group/other bits. */
export function ensurePrivateDir(dir: string, platform: NodeJS.Platform, uid: number): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform === 'win32') return; // per-user %APPDATA% ACLs; no POSIX modes
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`unsafe directory (not a real directory): ${dir}`);
  if (st.uid !== uid) throw new Error(`unsafe directory (owned by another user): ${dir}`);
  if ((st.mode & 0o077) !== 0) {
    fs.chmodSync(dir, 0o700);
    const again = fs.lstatSync(dir);
    if ((again.mode & 0o077) !== 0) throw new Error(`unsafe directory permissions: ${dir}`);
  }
}

/** Append-only log with size rotation (5 MB × 3). Never throws. */
export class RotatingLog {
  private fd: number | null = null;
  private size = 0;
  constructor(
    private readonly path: string,
    private readonly maxBytes = LOG_MAX_BYTES,
    private readonly keep = LOG_KEEP,
  ) {}

  private open(): void {
    if (this.fd !== null) return;
    this.fd = fs.openSync(this.path, 'a', 0o600);
    this.size = fs.fstatSync(this.fd).size;
  }

  private rotate(): void {
    this.close();
    for (let i = this.keep - 1; i >= 1; i--) {
      try {
        fs.renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
      } catch {
        /* missing */
      }
    }
    try {
      fs.renameSync(this.path, `${this.path}.1`);
    } catch {
      /* missing */
    }
    try {
      fs.rmSync(`${this.path}.${this.keep + 1}`, { force: true });
    } catch {
      /* ignore */
    }
  }

  write(chunk: Buffer | string): void {
    try {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      this.open();
      if (this.size + buf.length > this.maxBytes && this.size > 0) {
        this.rotate();
        this.open();
      }
      fs.writeSync(this.fd!, buf);
      this.size += buf.length;
    } catch {
      /* logging must never break the manager */
    }
  }

  close(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* ignore */
      }
      this.fd = null;
    }
  }
}

/** Remove anything that looks like a Tailscale/Headscale key or a URL from text bound for logs. */
export function redact(text: string): string {
  return text.replace(/(?:hs|ts)key-[\w-]+/g, '<redacted-key>').replace(/\bhttps?:\/\/[^\s"'<>]+/gi, '<url>');
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class NetManager extends EventEmitter<NetManagerEvents> {
  private child: ChildProcess | null = null;
  private endpoint: Endpoint | null = null;
  private launch: SidecarLaunch | null = null;
  private wanted = false;
  private current: NetStatus = { state: 'stopped' };
  private lastJson = '';
  private failures: number[] = [];
  private restarts = 0;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping: Promise<void> | null = null;
  private readyWaiters: Array<() => void> = [];
  private logFile: RotatingLog | null = null;
  private readonly platform: NodeJS.Platform;
  private readonly spawnFn: SpawnFn;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;

  constructor(private readonly opts: NetManagerOptions) {
    super();
    this.platform = opts.platform ?? process.platform;
    this.spawnFn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
    this.log = opts.log ?? ((m) => console.error(`[network] ${m}`));
    this.now = opts.now ?? Date.now;
  }

  // ------------------------------------------------------------------ paths

  get binPath(): string {
    return join(this.opts.binDir, this.platform === 'win32' ? 'airbridge-net.exe' : 'airbridge-net');
  }

  get stateDir(): string {
    return join(this.opts.dataDir, STATE_DIRNAME);
  }

  private uid(): number {
    return this.opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : -1);
  }

  /** True when no node state exists yet (never enrolled on this computer, or wiped). */
  hasState(): boolean {
    return fs.existsSync(join(this.stateDir, 'tailscaled.state'));
  }

  // ------------------------------------------------------------------ public API

  isRunning(): boolean {
    return this.child !== null && this.endpoint !== null;
  }

  /** Environment for the daemon (ProcessManager): sidecar control API, or null when not running. */
  daemonEnv(): Record<string, string> | null {
    const ep = this.endpoint;
    if (!ep) return null;
    return { AIRBRIDGE_NETWORK: 'sidecar', AIRBRIDGE_NET_URL: controlUrlLocal(ep), AIRBRIDGE_NET_TOKEN: ep.token };
  }

  /**
   * (Re)start the sidecar. Idempotent for the same control URL + hostname without a key; a launch with an
   * auth key (or a different server/hostname) respawns. Resolves once READY or the attempt failed.
   */
  async start(launch: SidecarLaunch): Promise<void> {
    if (this.stopping) await this.stopping;
    const same =
      this.launch && this.launch.controlUrl === launch.controlUrl && this.launch.hostname === launch.hostname;
    if (this.child && same && !launch.authKey) {
      if (!this.endpoint) await this.waitReady();
      return;
    }
    if (this.child || this.restartTimer) await this.halt();
    this.wanted = true;
    this.launch = { ...launch };
    this.failures = [];
    this.restarts = 0;
    this.setStatus({ state: 'starting' });
    try {
      if (!fs.existsSync(this.binPath)) throw new Error('private network component is missing from this build');
      ensurePrivateDir(this.opts.dataDir, this.platform, this.uid());
      ensurePrivateDir(this.stateDir, this.platform, this.uid());
      ensurePrivateDir(join(this.opts.dataDir, 'logs'), this.platform, this.uid());
      await this.cleanupStale();
    } catch (e) {
      this.wanted = false;
      this.launch = null;
      this.log(`start failed: ${e instanceof Error ? e.message : String(e)}`);
      this.setStatus({ state: 'error', detail: 'Could not start the private network.' });
      return;
    }
    this.logFile ??= new RotatingLog(join(this.opts.dataDir, 'logs', 'airbridge-net.log'));
    const ready = this.waitReady();
    this.spawnChild();
    await ready;
    if (this.endpoint) await this.pollOnce();
  }

  async stop(): Promise<void> {
    await this.halt();
    this.launch = null;
    this.logFile?.close();
    this.setStatus({ state: 'stopped' });
  }

  async status(): Promise<NetStatus> {
    if (this.wanted && this.endpoint) await this.pollOnce();
    return { ...this.current };
  }

  /** Latest known status without asking the sidecar. */
  lastStatus(): NetStatus {
    return { ...this.current };
  }

  /** Leave the private network (node key expired on Headscale) and forget the enrollment record. */
  async logout(): Promise<void> {
    if (this.endpoint) {
      const res = await this.request('POST', '/logout').catch(() => null);
      if (!res || res.status !== 200) this.log('logout: the private network did not confirm');
    }
    try {
      this.mergeNetworkJson({ login_server: null, enrolled_sub_hash: null });
    } catch {
      /* ignore */
    }
  }

  /** Delete the node state (another account signs in, or sign-out). The sidecar must be stopped. */
  async wipeState(): Promise<void> {
    if (this.child) await this.stop();
    await fs.promises.rm(this.stateDir, { recursive: true, force: true }).catch(() => undefined);
  }

  /** enroll.ts: the recorded enrollment (login server + sha256(clerk sub)), or null. */
  enrollment(): { loginServer: string | null; subHash: string | null } {
    const j = this.readNetworkJson();
    return {
      loginServer: typeof j?.login_server === 'string' ? j.login_server : null,
      subHash: typeof j?.enrolled_sub_hash === 'string' ? j.enrolled_sub_hash : null,
    };
  }

  /** enroll.ts hook: persist the enrollment (NetManager owns network.json). */
  recordEnrollment(info: { loginServer: string; subHash: string }): void {
    this.mergeNetworkJson({ login_server: info.loginServer, enrolled_sub_hash: info.subHash });
  }

  // ------------------------------------------------------------------ internals

  private setStatus(s: NetStatus): void {
    const json = JSON.stringify(s);
    this.current = s;
    if (json === this.lastJson) return;
    this.lastJson = json;
    this.emit('status', { ...s });
  }

  private waitReady(): Promise<void> {
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  private releaseWaiters(): void {
    const w = this.readyWaiters;
    this.readyWaiters = [];
    for (const r of w) r();
  }

  private spawnChild(): void {
    const launch = this.launch;
    if (!launch) return;
    const token = (this.opts.generateToken ?? (() => randomBytes(32).toString('base64url')))();
    this.endpoint = null;
    let child: ChildProcess;
    try {
      child = this.spawnFn(this.binPath, [], {
        env: scrubEnv(this.opts.baseEnv ?? process.env, this.platform),
        cwd: this.opts.dataDir,
        stdio: ['pipe', 'ignore', 'pipe'],
        windowsHide: true,
        detached: false,
        shell: false,
      });
    } catch (e) {
      this.log(`spawn failed: ${e instanceof Error ? e.message : String(e)}`);
      this.onExit(null);
      return;
    }
    this.child = child;
    const config: Record<string, unknown> = {
      control_url: launch.controlUrl,
      hostname: launch.hostname,
      control_token: token,
      state_dir: this.stateDir,
      parent_pid: this.opts.parentPid ?? process.pid,
    };
    if (launch.authKey) config.auth_key = launch.authKey;
    // The key is single use: never re-sent on a crash restart (tsnet keeps the node state).
    delete this.launch!.authKey;
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(`${JSON.stringify(config)}\n`);

    let buf = '';
    child.stderr?.on('data', (chunk: Buffer | string) => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        this.onLine(child, line, token);
      }
      if (buf.length > MAX_LINE * 4) buf = buf.slice(-MAX_LINE);
    });
    child.once('error', (err) => {
      this.log(`airbridge-net error: ${err.message}`);
      if (this.child === child) {
        this.child = null;
        this.onExit(null);
      }
    });
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.onExit(code, signal);
    });
    const readyTimeout = this.opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (this.child === child && !this.endpoint) {
        this.log(`airbridge-net did not report READY within ${readyTimeout} ms; killing it`);
        void this.killChild(child);
      }
    }, readyTimeout);
    this.readyTimer.unref?.();
  }

  private onLine(child: ChildProcess, line: string, token: string): void {
    if (this.child !== child) return;
    const ready = parseNetReady(line);
    if (ready && !this.endpoint) {
      if (child.pid && ready.pid !== child.pid) {
        this.log('ignoring READY line with a foreign pid');
        return;
      }
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyTimer = null;
      this.endpoint = { host: ready.host, port: ready.port, token, pid: ready.pid };
      try {
        this.writeNetworkJson();
      } catch (e) {
        this.log(`could not write ${NETWORK_JSON}: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.setStatus({ state: 'connecting' });
      this.startHealth();
      this.releaseWaiters();
      return;
    }
    const safe = redact(line.slice(0, MAX_LINE)).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '?');
    if (safe.trim()) this.logFile?.write(`${new Date(this.now()).toISOString()} ${safe}\n`);
  }

  private onExit(code: number | null, signal?: NodeJS.Signals | null): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.endpoint = null;
    this.stopHealth();
    this.markStopped();
    if (!this.wanted) {
      this.releaseWaiters();
      return;
    }
    const t = this.now();
    this.failures = this.failures.filter((f) => t - f < FAILURE_WINDOW_MS);
    this.failures.push(t);
    this.log(`airbridge-net exited unexpectedly (code=${code} signal=${signal ?? null})`);
    if (this.failures.length >= MAX_FAILURES) {
      this.wanted = false;
      this.setStatus({ state: 'error', detail: 'The private network keeps stopping.' });
      this.releaseWaiters();
      return;
    }
    this.restarts += 1;
    const delay = (this.opts.backoffMs ?? defaultBackoffMs)(this.restarts);
    // Transient: stay in 'starting' (the UI treats 'error' as a full-screen error).
    this.setStatus({ state: 'starting', detail: 'Reconnecting…' });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.wanted && !this.child && !this.stopping) this.spawnChild();
    }, delay);
    this.restartTimer.unref?.();
  }

  private startHealth(): void {
    this.stopHealth();
    this.healthTimer = setInterval(() => void this.pollOnce(), this.opts.healthIntervalMs ?? HEALTH_INTERVAL_MS);
    this.healthTimer.unref?.();
  }

  private stopHealth(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  private polling: Promise<void> | null = null;

  private pollOnce(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = this.doPoll().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private async doPoll(): Promise<void> {
    const ep = this.endpoint;
    if (!this.wanted || !ep) return;
    const res = await this.request('GET', '/status').catch(() => null);
    if (this.endpoint !== ep || !this.wanted) return;
    if (!res || res.status !== 200) {
      if (this.current.state !== 'error') this.setStatus({ state: 'connecting' });
      return;
    }
    this.setStatus(parseSidecarStatus(res.body));
  }

  /** One request to the sidecar's control API (bearer, exact Host, no Origin). */
  request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const ep = this.endpoint;
    if (!ep) return Promise.reject(new Error('not running'));
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const hostHeader = ep.host === '::1' ? `[::1]:${ep.port}` : `127.0.0.1:${ep.port}`;
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: ep.host,
          family: ep.host === '::1' ? 6 : 4,
          port: ep.port,
          method,
          path,
          agent: false,
          timeout: REQUEST_TIMEOUT_MS,
          headers: {
            host: hostHeader,
            authorization: `Bearer ${ep.token}`,
            accept: 'application/json',
            ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_RESPONSE) req.destroy(new Error('response too large'));
            else chunks.push(c);
          });
          res.on('end', () => {
            let parsed: unknown = null;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              parsed = null;
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end(payload);
    });
  }

  private clearTimers(): void {
    this.stopHealth();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.restartTimer = this.readyTimer = null;
  }

  private async halt(): Promise<void> {
    this.wanted = false;
    this.clearTimers();
    if (this.stopping) return this.stopping;
    const child = this.child;
    this.stopping = (async () => {
      if (child) await this.killChild(child);
    })();
    try {
      await this.stopping;
    } finally {
      this.stopping = null;
      this.child = null;
      this.endpoint = null;
      this.markStopped();
      this.releaseWaiters();
    }
  }

  // ---- network.json v2 (0600, atomic) ---------------------------------------------------

  private networkJsonPath(): string {
    return join(this.opts.dataDir, NETWORK_JSON);
  }

  private readNetworkJson(): Record<string, unknown> | null {
    try {
      const v = JSON.parse(fs.readFileSync(this.networkJsonPath(), 'utf8')) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private atomicWrite(obj: Record<string, unknown>): void {
    const path = this.networkJsonPath();
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, path);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  private writeNetworkJson(): void {
    const ep = this.endpoint;
    if (!ep) return;
    const prev = this.readNetworkJson();
    const keep = prev?.v === 2 ? prev : {};
    this.atomicWrite({
      v: 2,
      mode: 'sidecar',
      control_url_local: controlUrlLocal(ep),
      control_token: ep.token,
      pid: ep.pid,
      bin: this.binPath,
      login_server: keep.login_server ?? null,
      enrolled_sub_hash: keep.enrolled_sub_hash ?? null,
    });
  }

  private mergeNetworkJson(patch: Record<string, unknown>): void {
    const prev = this.readNetworkJson();
    const base = prev?.v === 2 ? prev : { v: 2, mode: 'sidecar', pid: null };
    this.atomicWrite({ ...base, ...patch, v: 2, mode: 'sidecar' });
  }

  /** After stop/crash the pid and token are gone; keep the file so the MCP process can say "network is off". */
  private markStopped(): void {
    const prev = this.readNetworkJson();
    if (prev && (prev.pid || prev.control_token)) {
      try {
        this.atomicWrite({ ...prev, pid: null, control_token: null });
      } catch {
        /* ignore */
      }
    }
  }

  // ---- stale cleanup ----------------------------------------------------------------------

  /** Kill a sidecar left by a crashed previous run: only if its pid is alive AND it is our binary. */
  async cleanupStale(): Promise<'killed' | 'none' | 'ignored'> {
    const prev = this.readNetworkJson();
    const pid = prev?.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) return 'none';
    if (!(this.opts.isPidAlive ?? defaultIsPidAlive)(pid)) return 'none';
    const exe = await (this.opts.processExePath ?? ((p: number) => processExePath(p, this.platform)))(pid).catch(() => null);
    if (!exe || !samePath(exe, this.binPath, this.platform)) {
      this.log(`pid ${pid} from ${NETWORK_JSON} is not our airbridge-net (pid reuse); leaving it alone`);
      return 'ignored';
    }
    this.log(`stopping leftover airbridge-net (pid ${pid})`);
    await (this.opts.killPid ?? ((p: number) => killPid(p, this.platform, this.spawnFn)))(pid);
    return 'killed';
  }

  private killChild(child: ChildProcess): Promise<void> {
    const timeout = this.opts.stopTimeoutMs ?? STOP_TIMEOUT_MS;
    return new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      child.once('exit', finish);
      if (this.platform === 'win32') {
        if (child.pid) {
          try {
            const tk = this.spawnFn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, shell: false });
            tk.once?.('error', () => undefined);
          } catch {
            /* fall through */
          }
        }
        timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* gone */
          }
          setTimeout(finish, 500).unref?.();
        }, timeout);
        return;
      }
      try {
        child.kill('SIGTERM');
      } catch {
        /* gone */
      }
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* gone */
        }
        setTimeout(finish, 1000).unref?.();
      }, timeout);
    });
  }
}

// ------------------------------------------------------------------ helpers

function controlUrlLocal(ep: Endpoint): string {
  return ep.host === '::1' ? `http://[::1]:${ep.port}` : `http://127.0.0.1:${ep.port}`;
}

export function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const norm = (p: string) => {
    let r = p;
    try {
      r = fs.realpathSync(p);
    } catch {
      /* keep as is */
    }
    return platform === 'win32' || platform === 'darwin' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

export async function processExePath(pid: number, platform: NodeJS.Platform): Promise<string | null> {
  if (platform === 'linux') {
    try {
      return fs.readlinkSync(`/proc/${pid}/exe`);
    } catch {
      return null;
    }
  }
  const run = (file: string, args: string[]) =>
    new Promise<string | null>((resolve) => {
      nodeExecFile(file, args, { windowsHide: true, timeout: 5000, encoding: 'utf8' }, (err, stdout) => resolve(err ? null : String(stdout).trim() || null));
    });
  if (platform === 'darwin') return run('/bin/ps', ['-o', 'comm=', '-p', String(pid)]);
  if (platform === 'win32') {
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Math.trunc(pid)}).Path`]);
  }
  return null;
}

async function killPid(pid: number, platform: NodeJS.Platform, spawnFn: SpawnFn): Promise<void> {
  if (platform === 'win32') {
    await new Promise<void>((resolve) => {
      try {
        const tk = spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, shell: false });
        tk.once('exit', () => resolve());
        tk.once('error', () => resolve());
      } catch {
        resolve();
      }
    });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!defaultIsPidAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* gone */
  }
}
