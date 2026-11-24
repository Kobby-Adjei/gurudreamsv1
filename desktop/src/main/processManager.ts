/**
 * Supervises the airbridge-core daemon (`airbridge-core --daemon`).
 *
 * - Spawned ONLY via start(), which the LicenseGate calls on a valid license (index.ts wiring).
 * - A fresh control token per spawn: crypto.randomBytes(32) base64url, passed in the child's
 *   environment (AIRBRIDGE_CONTROL_TOKEN) and never on argv, never logged, never sent to the renderer.
 * - stdio: ["ignore", "ignore", "pipe"]; stderr is parsed for the single
 *   `AIRBRIDGE_READY {"control_port":N,"pid":P}` line.
 * - Unexpected exits restart with exponential backoff, at most MAX_RESTARTS times in a row
 *   (the counter resets after the daemon has been healthy for STABLE_RESET_MS).
 * - stop(): SIGTERM, then SIGKILL after 3 s (Windows: `taskkill /PID <pid> /T /F`).
 * - The daemon also watches AIRBRIDGE_PARENT_PID and exits by itself if this app dies.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { dirname, isAbsolute } from 'node:path';
import type { BackendLifecycle, NetStatus } from '../shared/types';
import type { SidecarLaunch } from './network/NetManager';

export const READY_PREFIX = 'AIRBRIDGE_READY ';
/** The only network variables the daemon gets (from NetworkSupervisor.daemonEnv()). */
export const NETWORK_ENV_KEYS = ['AIRBRIDGE_NETWORK', 'AIRBRIDGE_NET_URL', 'AIRBRIDGE_NET_TOKEN'] as const;
export const MAX_RESTARTS = 5;
export const STOP_TIMEOUT_MS = 3000;
export const READY_TIMEOUT_MS = 30_000;
export const STABLE_RESET_MS = 60_000;
const MAX_STDERR_LINE = 2000;
const STDERR_TAIL_LINES = 5;

/** Connection details for the control API. Main-process only: contains the bearer token. */
export interface BackendConnection {
  port: number;
  pid: number;
  token: string;
  /** Loopback the control API bound (`::1` preferred, F-1); absent on Phase-2 daemons (= 127.0.0.1). */
  host?: '::1' | '127.0.0.1';
}

export interface CoreCommand {
  command: string;
  args: string[];
}

type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface ProcessManagerOptions {
  /** Resolved core command (mcpConfig.resolveCoreCommand); `--daemon` is appended. */
  core: CoreCommand | (() => CoreCommand);
  /** Base environment for the child (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** AIRBRIDGE_DATA_DIR for the daemon (activity.jsonl, logs). */
  dataDir?: string;
  /**
   * Phase 3 §9: extra variables evaluated at every spawn (NetworkSupervisor.daemonEnv():
   * AIRBRIDGE_NETWORK=sidecar [+ AIRBRIDGE_NET_URL, AIRBRIDGE_NET_TOKEN]). null/undefined = none.
   */
  extraEnv?: () => Record<string, string> | null | undefined;
  /**
   * Working directory for the daemon. Default: the binary's own directory (or main.py's in dev),
   * never the app's inherited cwd: on Windows the tailscale lookup would otherwise consider a
   * planted tailscale.exe in the cwd.
   */
  cwd?: string;
  /** Control port (default 0 = ephemeral). */
  controlPort?: number;
  maxRestarts?: number;
  /** Delay before restart attempt n (1-based). Default 1s, 2s, 4s, 8s, 16s (cap 30s). */
  backoffMs?: (attempt: number) => number;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  stableResetMs?: number;
  /** Injection points for tests. */
  spawn?: SpawnFn;
  platform?: NodeJS.Platform;
  parentPid?: number;
  generateToken?: () => string;
  log?: (msg: string) => void;
}

export function generateControlToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Trusted cwd for the daemon (see ProcessManagerOptions.cwd). */
export function daemonCwd(core: CoreCommand, fallback?: string): string {
  if (isAbsolute(core.command)) return dirname(core.command);
  const script = core.args[0];
  if (script && isAbsolute(script)) return dirname(script);
  return fallback ?? homedir();
}

export function defaultBackoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

/** Parse one stderr line; returns {port,pid[,host]} for a valid READY line, else null. */
export function parseReadyLine(line: string): { port: number; pid: number; host?: '::1' | '127.0.0.1' } | null {
  if (!line.startsWith(READY_PREFIX)) return null;
  try {
    const obj = JSON.parse(line.slice(READY_PREFIX.length)) as { control_port?: unknown; pid?: unknown; control_host?: unknown };
    const port = obj.control_port;
    const pid = obj.pid;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1) return null;
    if (obj.control_host === undefined) return { port, pid };
    if (obj.control_host !== '::1' && obj.control_host !== '127.0.0.1') return null;
    return { port, pid, host: obj.control_host };
  } catch {
    return null;
  }
}

export interface ProcessManagerEvents {
  lifecycle: [BackendLifecycle];
  ready: [BackendConnection];
  exit: [{ code: number | null; signal: NodeJS.Signals | null; expected: boolean }];
}

export class ProcessManager extends EventEmitter<ProcessManagerEvents> {
  private child: ChildProcess | null = null;
  private lifecycle: BackendLifecycle = { phase: 'stopped' };
  private connection: BackendConnection | null = null;
  private wanted = false;
  private restarts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping: Promise<void> | null = null;
  private readyWaiters: Array<(ok: boolean) => void> = [];
  private stderrTail: string[] = [];
  private readonly spawnFn: SpawnFn;
  private readonly platform: NodeJS.Platform;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: ProcessManagerOptions) {
    super();
    this.spawnFn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
    this.platform = opts.platform ?? process.platform;
    this.log = opts.log ?? ((m) => console.error(`[backend] ${m}`));
  }

  getLifecycle(): BackendLifecycle {
    return { ...this.lifecycle };
  }

  /** Control API connection (port + token) while running, else null. Never expose to the renderer. */
  getConnection(): BackendConnection | null {
    return this.connection ? { ...this.connection } : null;
  }

  isRunning(): boolean {
    return this.lifecycle.phase === 'running' && this.connection !== null;
  }

  /**
   * Start the daemon (idempotent). Called by the license gate on a valid license.
   * Resolves true once READY, false if it could not start (lifecycle says why).
   */
  async start(): Promise<boolean> {
    if (this.stopping) await this.stopping;
    this.wanted = true;
    if (this.child && this.connection) return true;
    const waiter = new Promise<boolean>((resolve) => this.readyWaiters.push(resolve));
    if (!this.child && !this.restartTimer) {
      this.restarts = 0;
      this.spawnChild();
    }
    return waiter;
  }

  /** Stop the daemon (app quit / sign-out). Phase becomes "stopped". */
  async stop(): Promise<void> {
    await this.halt({ phase: 'stopped' });
  }

  /** Stop because the license gate denied access. Phase becomes "blocked". */
  async block(detail?: string): Promise<void> {
    await this.halt(detail ? { phase: 'blocked', detail } : { phase: 'blocked' });
  }

  // ------------------------------------------------------------------ internals

  private setLifecycle(l: BackendLifecycle): void {
    this.lifecycle = l;
    this.emit('lifecycle', { ...l });
  }

  private resolveWaiters(ok: boolean): void {
    const w = this.readyWaiters;
    this.readyWaiters = [];
    for (const r of w) r(ok);
  }

  private clearTimers(): void {
    for (const t of [this.restartTimer, this.readyTimer, this.stableTimer]) if (t) clearTimeout(t);
    this.restartTimer = this.readyTimer = this.stableTimer = null;
  }

  private core(): CoreCommand {
    return typeof this.opts.core === 'function' ? this.opts.core() : this.opts.core;
  }

  private spawnChild(): void {
    const token = (this.opts.generateToken ?? generateControlToken)();
    const { command, args } = this.core();
    const env: NodeJS.ProcessEnv = {
      ...(this.opts.env ?? process.env),
      AIRBRIDGE_CONTROL_TOKEN: token,
      AIRBRIDGE_CONTROL_PORT: String(this.opts.controlPort ?? 0),
      AIRBRIDGE_PARENT_PID: String(this.opts.parentPid ?? process.pid),
      PYTHONUNBUFFERED: '1',
    };
    if (this.opts.dataDir) env.AIRBRIDGE_DATA_DIR = this.opts.dataDir;
    // Never inherit a stale network selection from the app's own environment.
    for (const k of [...NETWORK_ENV_KEYS, 'AIRBRIDGE_TS_SOCKET', 'AIRBRIDGE_TS_SOCKS5']) delete env[k];
    const extra = this.opts.extraEnv?.();
    if (extra) {
      for (const k of NETWORK_ENV_KEYS) {
        if (typeof extra[k] === 'string' && extra[k]) env[k] = extra[k];
      }
    }
    delete env.ELECTRON_RUN_AS_NODE;

    this.connection = null;
    this.stderrTail = [];
    this.setLifecycle({
      phase: 'starting',
      ...(this.restarts > 0 ? { detail: `Restarting (attempt ${this.restarts} of ${this.maxRestarts()})` } : {}),
    });

    let child: ChildProcess;
    try {
      child = this.spawnFn(command, [...args, '--daemon'], {
        env,
        cwd: this.opts.cwd ?? daemonCwd({ command, args }, this.opts.dataDir),
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        detached: false,
        shell: false,
      });
    } catch (e) {
      this.log(`spawn failed: ${e instanceof Error ? e.message : String(e)}`);
      this.onChildGone(null, null, `Could not start the AirBridge engine (${shortError(e)}).`);
      return;
    }
    this.child = child;

    let buf = '';
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (chunk: string | Buffer) => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        this.onStderrLine(child, line, token);
      }
      if (buf.length > MAX_STDERR_LINE * 4) buf = buf.slice(-MAX_STDERR_LINE);
    });
    child.once('error', (err) => {
      this.log(`engine process error: ${err.message}`);
      if (this.child === child) {
        this.child = null;
        this.onChildGone(null, null, `Could not start the AirBridge engine (${shortError(err)}).`);
      }
    });
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.onChildGone(code, signal);
    });

    const readyTimeout = this.opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (this.child === child && !this.connection) {
        this.log(`engine did not report READY within ${readyTimeout} ms; killing it`);
        void this.killChild(child);
      }
    }, readyTimeout);
    this.readyTimer.unref?.();
  }

  private onStderrLine(child: ChildProcess, line: string, token: string): void {
    if (this.child !== child) return;
    const ready = parseReadyLine(line);
    if (ready && !this.connection) {
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyTimer = null;
      this.connection = { port: ready.port, pid: ready.pid, token, ...(ready.host ? { host: ready.host } : {}) };
      this.log(`engine ready (pid ${ready.pid})`);
      this.setLifecycle({ phase: 'running' });
      this.emit('ready', { ...this.connection });
      this.resolveWaiters(true);
      const stable = this.opts.stableResetMs ?? STABLE_RESET_MS;
      this.stableTimer = setTimeout(() => {
        this.stableTimer = null;
        this.restarts = 0;
      }, stable);
      this.stableTimer.unref?.();
      return;
    }
    const safe = line.slice(0, MAX_STDERR_LINE).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '?');
    if (!safe.trim()) return;
    this.stderrTail.push(safe);
    if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
    this.log(`engine: ${safe}`);
  }

  private maxRestarts(): number {
    return this.opts.maxRestarts ?? MAX_RESTARTS;
  }

  private onChildGone(code: number | null, signal: NodeJS.Signals | null, reason?: string): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.readyTimer = this.stableTimer = null;
    this.connection = null;
    const expected = !this.wanted || this.stopping !== null;
    this.emit('exit', { code, signal, expected });
    if (expected) return;

    const lastErr = this.stderrTail.filter((l) => l.startsWith('AirBridge:')).pop();
    const detail =
      reason ??
      (lastErr ? lastErr.replace(/^AirBridge:\s*/, '') : `The AirBridge engine exited (${signal ?? `code ${code}`}).`);
    this.log(`engine exited unexpectedly (code=${code} signal=${signal})`);

    if (this.restarts >= this.maxRestarts()) {
      this.wanted = false;
      this.setLifecycle({ phase: 'crashed', detail: `${detail} Gave up after ${this.maxRestarts()} restarts.` });
      this.resolveWaiters(false);
      return;
    }
    this.restarts += 1;
    const delay = (this.opts.backoffMs ?? defaultBackoffMs)(this.restarts);
    this.setLifecycle({ phase: 'crashed', detail: `${detail} Restarting in ${Math.round(delay / 1000)}s.` });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.wanted && !this.child && !this.stopping) this.spawnChild();
    }, delay);
    this.restartTimer.unref?.();
  }

  private async halt(final: BackendLifecycle): Promise<void> {
    this.wanted = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.stopping) {
      await this.stopping;
      this.setLifecycle(final);
      return;
    }
    const child = this.child;
    this.stopping = (async () => {
      if (child) await this.killChild(child);
    })();
    try {
      await this.stopping;
    } finally {
      this.stopping = null;
      this.clearTimers();
      this.connection = null;
      this.resolveWaiters(false);
      this.setLifecycle(final);
    }
  }

  /** SIGTERM -> wait stopTimeoutMs -> SIGKILL (Windows: taskkill /T /F). Resolves on exit. */
  private killChild(child: ChildProcess): Promise<void> {
    const timeout = this.opts.stopTimeoutMs ?? STOP_TIMEOUT_MS;
    return new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      let done = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (killTimer) clearTimeout(killTimer);
        resolve();
      };
      child.once('exit', finish);
      if (this.platform === 'win32') {
        this.taskkill(child);
        killTimer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* already gone */
          }
          setTimeout(finish, 500).unref?.();
        }, timeout);
        return;
      }
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        // If the exit event never arrives, don't hang app quit.
        setTimeout(finish, 1000).unref?.();
      }, timeout);
    });
  }

  private taskkill(child: ChildProcess): void {
    if (!child.pid) return;
    try {
      const tk = this.spawnFn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      });
      tk.once?.('error', () => undefined);
    } catch {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
  }
}

function shortError(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  if (typeof code === 'string') return code;
  return e instanceof Error ? e.message.slice(0, 120) : 'unknown error';
}

/**
 * LicenseGate callbacks: the ONLY path that starts the daemon. onValid -> start();
 * onInvalid -> block() (stop the daemon, lifecycle "blocked").
 */
export function licenseGateCallbacks(pm: Pick<ProcessManager, 'start' | 'block'>): {
  onValid: () => Promise<void>;
  onInvalid: (reason: string) => Promise<void>;
} {
  return {
    onValid: async () => {
      await pm.start();
    },
    onInvalid: async (reason: string) => {
      await pm.block(`License check: ${reason}`);
    },
  };
}

// ------------------------------------------------------------------ private network (PHASE3_PLAN.md §8, §9)

/** The slice of NetManager the supervisor needs. */
export interface NetworkSupervisorNm {
  start(launch: SidecarLaunch): Promise<void>;
  stop(): Promise<void>;
  logout(): Promise<void>;
  wipeState(): Promise<void>;
  status(): Promise<NetStatus>;
  lastStatus(): NetStatus;
  isRunning(): boolean;
  daemonEnv(): Record<string, string> | null;
  on(event: 'status', cb: (s: NetStatus) => void): unknown;
}

export interface NetworkSupervisorOptions {
  nm: NetworkSupervisorNm;
  /** licenseEnforced(): true = the gate drives start (license valid -> network -> daemon). */
  enforced: boolean;
  /** Signed in AND a license server is configured: enrollment can be attempted. */
  canEnroll: () => boolean;
  /** ensureEnrolled wrapper (spawns the sidecar); resolves true when this device is on the network. Never throws. */
  enroll: () => Promise<boolean>;
  onNetwork: (s: NetStatus) => void;
  log?: (msg: string) => void;
}

/** Shown while nobody is signed in: the app never falls back to a system Tailscale (§9). */
export const SIGNED_OUT_STATUS: NetStatus = { state: 'needs_login', mode: 'embedded' };

/**
 * Owns the private network (the airbridge-net sidecar) and starts the daemon with its endpoint.
 *
 * The app path never uses a system Tailscale. The daemon always runs with AIRBRIDGE_NETWORK=sidecar;
 * while the sidecar is not running (signed out, enrollment failed) it gets no endpoint and its inbox
 * stays degraded ("AirBridge network is off"), while the feed and MCP config keep working.
 *
 * Preview (not enforced): start() starts the daemon right away; signed in + license server configured
 * -> enrollment (sidecar) first. Signed out -> NetStatus {state:'needs_login', mode:'embedded'}.
 * Enforced: nothing starts until the LicenseGate calls licenseValid(); licenseInvalid() blocks.
 */
export class NetworkSupervisor {
  private pm: ProcessManager | null = null;
  private daemonNetEnv = '';
  private chain: Promise<void> = Promise.resolve();
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: NetworkSupervisorOptions) {
    this.log = opts.log ?? (() => undefined);
    opts.nm.on('status', (s) => {
      this.opts.onNetwork(this.tag(s));
      // A sidecar restarted after a crash has a new endpoint: hand it to the daemon.
      if (this.pm && this.opts.nm.isRunning() && this.daemonNetEnv && JSON.stringify(this.daemonEnv()) !== this.daemonNetEnv) {
        const phase = this.pm.getLifecycle().phase;
        if (phase === 'running' || phase === 'starting') void this.serial(() => this.startDaemon());
      }
    });
  }

  /** Wire the ProcessManager (constructed with `extraEnv: () => supervisor.daemonEnv()`). */
  attach(pm: ProcessManager): void {
    this.pm = pm;
  }

  /** ProcessManager.extraEnv: the sidecar endpoint when running, else sidecar mode without one. */
  daemonEnv(): Record<string, string> {
    return this.opts.nm.daemonEnv() ?? { AIRBRIDGE_NETWORK: 'sidecar' };
  }

  /** NetStatus for IPC (network.getStatus). Always mode 'embedded'. */
  async status(): Promise<NetStatus> {
    if (!this.opts.canEnroll()) return { ...SIGNED_OUT_STATUS };
    return this.tag(await this.opts.nm.status());
  }

  /** App start (after the window loaded). Enforced: the gate drives everything. */
  async start(): Promise<void> {
    if (this.opts.enforced) return;
    await this.serial(() => this.bringUp());
  }

  /** LicenseGate.onValid. */
  async licenseValid(): Promise<void> {
    if (!this.opts.enforced) {
      this.log('license valid (preview: not enforced)');
      return;
    }
    await this.serial(() => this.bringUp());
  }

  /** LicenseGate.onInvalid. */
  async licenseInvalid(reason: string): Promise<void> {
    if (!this.opts.enforced) {
      this.log(`license would block (${reason}) - preview: not enforced, backend keeps running`);
      return;
    }
    await this.serial(async () => {
      await this.pmRef().block(`License check: ${reason}`);
      await this.opts.nm.stop();
    });
  }

  /** Auth became signed_in. Preview: join the private network now. */
  async signedIn(): Promise<void> {
    if (this.opts.enforced) return; // gate.check() -> licenseValid()
    await this.serial(() => this.bringUp());
  }

  /** Sign-out: leave the private network (logout + wipe node state); preview keeps the daemon running. */
  async signedOut(): Promise<void> {
    await this.serial(async () => {
      await this.pmRef().stop();
      if (this.opts.nm.isRunning()) await this.opts.nm.logout().catch(() => undefined);
      await this.opts.nm.stop();
      await this.opts.nm.wipeState().catch(() => undefined);
      this.opts.onNetwork({ ...SIGNED_OUT_STATUS });
      if (this.opts.enforced) return;
      await this.startDaemon();
    });
  }

  /** network.retry (IPC): re-run enrollment (restarts the sidecar if needed), then the daemon. */
  async retry(isEntitled: () => boolean): Promise<NetStatus> {
    await this.serial(async () => {
      if (this.opts.enforced && !isEntitled()) return;
      await this.bringUp();
    });
    return this.status();
  }

  /** App quit: daemon first, then the sidecar. */
  async stop(): Promise<void> {
    await this.pmRef().stop();
    await this.opts.nm.stop();
  }

  // ------------------------------------------------------------------ internals

  private pmRef(): ProcessManager {
    if (!this.pm) throw new Error('NetworkSupervisor: attach(pm) first');
    return this.pm;
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch((e: unknown) => this.log(`network: ${e instanceof Error ? e.message : String(e)}`));
    return this.chain;
  }

  private async bringUp(): Promise<void> {
    if (this.opts.canEnroll()) {
      if (!(await this.opts.enroll())) this.log('private network unavailable (the backend runs without it)');
    } else {
      if (this.opts.nm.isRunning()) await this.opts.nm.stop();
      this.opts.onNetwork({ ...SIGNED_OUT_STATUS });
    }
    await this.startDaemon();
  }

  /** Start the daemon, respawning it when the sidecar endpoint changed. */
  private async startDaemon(): Promise<void> {
    const pm = this.pmRef();
    const want = JSON.stringify(this.daemonEnv());
    const phase = pm.getLifecycle().phase;
    const active = phase === 'running' || phase === 'starting' || phase === 'crashed';
    if (active && want !== this.daemonNetEnv) await pm.stop(); // endpoint moved: respawn with the new env
    this.daemonNetEnv = want;
    await pm.start();
  }

  /** Every NetStatus leaving the supervisor is the app's own network (NetStatus.mode = 'embedded'). */
  private tag(s: NetStatus): NetStatus {
    return { ...s, mode: 'embedded' };
  }
}
