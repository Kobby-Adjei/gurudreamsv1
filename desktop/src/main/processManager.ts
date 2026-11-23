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
import type { BackendLifecycle } from '../shared/types';

export const READY_PREFIX = 'AIRBRIDGE_READY ';
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

/** Parse one stderr line; returns {port,pid} for a valid READY line, else null. */
export function parseReadyLine(line: string): { port: number; pid: number } | null {
  if (!line.startsWith(READY_PREFIX)) return null;
  try {
    const obj = JSON.parse(line.slice(READY_PREFIX.length)) as { control_port?: unknown; pid?: unknown };
    const port = obj.control_port;
    const pid = obj.pid;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1) return null;
    return { port, pid };
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
      this.connection = { port: ready.port, pid: ready.pid, token };
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
