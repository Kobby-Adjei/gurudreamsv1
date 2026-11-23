/**
 * Supervises the bundled userspace `tailscaled` (PHASE3_PLAN.md §2 "TailscaleManager API", §7 amendments,
 * PHASE3_SECURITY.md F-1/F-4/F-8/F-10).
 *
 *   start()  -> stale cleanup -> 0700 dirs (lstat/owner checked) -> spawn tailscaled (fixed argv, scrubbed env)
 *            -> health poll `tailscale --socket=S status --json` every 5 s
 *            -> first healthy status: write <D>/network.json (0600, atomic)
 *   crash    -> restart with backoff 1,2,4…30 s; 5 failures within 2 min -> state 'error' (and only then)
 *   stop()   -> SIGTERM, SIGKILL after 3 s (Windows: taskkill /PID /T /F)
 *   up()     -> `tailscale up --auth-key=file:<f> …` (the key itself never touches argv/env/logs)
 *
 * tailscaled argv (never user-controlled):
 *   --tun=userspace-networking --statedir=<D>/tailscaled --socket=<S> --socks5-server=[::1]:<P>
 *   --port=0 --no-logs-no-support [--windows-mode=dev]
 * The SOCKS5 listener binds IPv6 loopback because tailscaled's netstack forwards inbound tailnet traffic
 * for every port to 127.0.0.1 only (F-1); `--socks5-server=127.0.0.1:<P>` is the fallback on hosts
 * without an IPv6 loopback.
 */
import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir as osTmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { NetStatus } from '../../shared/types';

export const HEALTH_INTERVAL_MS = 5000;
export const STOP_TIMEOUT_MS = 3000;
export const MAX_FAILURES = 5;
export const FAILURE_WINDOW_MS = 120_000;
export const MAX_SOCKET_PATH_BYTES = 100;
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_KEEP = 3;
export const NETWORK_JSON = 'network.json';
const CLI_TIMEOUT_MS = 5000;
const UP_TIMEOUT_MS = 90_000;
const MAX_CLI_OUTPUT = 8 * 1024 * 1024;

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
export type CliFn = (file: string, args: readonly string[], opts: { env: NodeJS.ProcessEnv; timeoutMs: number; cwd: string }) => Promise<CliResult>;

export interface TailscaleManagerOptions {
  /** Directory holding tailscaled[.exe] + tailscale[.exe] (resources/tailscale/<platform>-<arch>). */
  binDir: string;
  /** Shared data dir D (dataDir.ts). */
  dataDir: string;
  platform?: NodeJS.Platform;
  /** Source of the scrubbed allow-listed variables (default: the app's environment). */
  baseEnv?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  cli?: CliFn;
  log?: (msg: string) => void;
  healthIntervalMs?: number;
  stopTimeoutMs?: number;
  backoffMs?: (attempt: number) => number;
  now?: () => number;
  /** Free loopback TCP port for SOCKS5 (default: bind :0 on the chosen loopback). */
  pickPort?: (host: string) => Promise<number>;
  /** Whether [::1] can be bound (default: probe). */
  ipv6Loopback?: () => Promise<boolean>;
  tmpdir?: string;
  uid?: number;
  username?: string;
  /** Stale cleanup hooks (tests). */
  isPidAlive?: (pid: number) => boolean;
  processExePath?: (pid: number) => Promise<string | null>;
  killPid?: (pid: number) => Promise<void>;
  /** Login-server state carried over into network.json (enroll.ts records these). */
}

export interface TailscaleManagerEvents {
  status: [NetStatus];
}

export function defaultBackoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

const ENV_ALLOW = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TEMP', 'TMP'];

/** Allow-listed environment for tailscaled / tailscale (PHASE3_PLAN.md §2). */
export function scrubEnv(source: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const names = platform === 'win32' ? [...ENV_ALLOW, 'SystemRoot'] : ENV_ALLOW;
  for (const name of names) {
    const v = source[name];
    if (typeof v === 'string' && v) out[name] = v;
  }
  out.TS_NO_LOGS_NO_SUPPORT = 'true';
  return out;
}

/** <S>: Unix socket under D (or a 0700 tmp dir when too long), Windows per-user + per-launch pipe (F-4). */
export function socketPathFor(o: {
  dataDir: string;
  platform: NodeJS.Platform;
  tmpdir: string;
  uid: number;
  username: string;
  random?: string;
}): { socket: string; dir: string | null } {
  if (o.platform === 'win32') {
    const userHash = createHash('sha256').update(o.username, 'utf8').digest('hex').slice(0, 12);
    const rnd = o.random ?? randomBytes(4).toString('hex');
    return { socket: `\\\\.\\pipe\\airbridge-tailscaled-${userHash}-${rnd}`, dir: null };
  }
  const inData = join(o.dataDir, 'tailscaled.sock');
  if (Buffer.byteLength(inData, 'utf8') <= MAX_SOCKET_PATH_BYTES) return { socket: inData, dir: o.dataDir };
  const dir = join(o.tmpdir, `airbridge-${o.uid}`);
  return { socket: join(dir, 'ts.sock'), dir };
}

export function tailscaledArgv(o: {
  dataDir: string;
  socket: string;
  socksHost: string;
  socksPort: number;
  platform: NodeJS.Platform;
}): string[] {
  const socks = o.socksHost === '::1' ? `--socks5-server=[::1]:${o.socksPort}` : `--socks5-server=127.0.0.1:${o.socksPort}`;
  const argv = [
    '--tun=userspace-networking',
    `--statedir=${join(o.dataDir, 'tailscaled')}`,
    `--socket=${o.socket}`,
    socks,
    '--port=0',
    '--no-logs-no-support',
  ];
  // A custom pipe outside \\.\pipe\ProtectedPrefix\Administrators\ is refused unless --windows-mode=dev,
  // which also restricts the pipe to the current user (cmd/tailscaled/tailscaled.go applyWindowsMode).
  if (o.platform === 'win32') argv.push('--windows-mode=dev');
  return argv;
}

/** ipnstate.Status JSON -> NetStatus. */
export function parseStatus(raw: string): NetStatus {
  let data: { BackendState?: unknown; Self?: { TailscaleIPs?: unknown } } | null;
  try {
    data = JSON.parse(raw) as typeof data;
  } catch {
    return { state: 'error', detail: 'Private network returned unreadable status.' };
  }
  const state = typeof data?.BackendState === 'string' ? data.BackendState : '';
  const ips = Array.isArray(data?.Self?.TailscaleIPs) ? (data!.Self!.TailscaleIPs as unknown[]) : [];
  const ip = ips.find((x): x is string => typeof x === 'string' && /^100\.\d+\.\d+\.\d+$/.test(x));
  switch (state) {
    case 'Running':
      return ip ? { state: 'connected', ip } : { state: 'connecting' };
    case 'NeedsLogin':
    case 'NoState':
    case 'Stopped':
      return { state: 'needs_login' };
    case 'NeedsMachineAuth':
      return { state: 'connecting', detail: 'Waiting for device approval.' };
    case 'Starting':
      return { state: 'connecting' };
    default:
      return { state: 'starting' };
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

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const defaultCli: CliFn = (file, args, opts) =>
  new Promise((resolve) => {
    nodeExecFile(
      file,
      [...args],
      { env: opts.env, cwd: opts.cwd, timeout: opts.timeoutMs, windowsHide: true, maxBuffer: MAX_CLI_OUTPUT, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : null) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });

function probeListen(host: string, port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(null));
    srv.listen({ host, port, ipv6Only: host === '::1' }, () => {
      const addr = srv.address();
      const p = addr && typeof addr === 'object' ? addr.port : null;
      srv.close(() => resolve(p));
    });
  });
}

export class TailscaleManager extends EventEmitter<TailscaleManagerEvents> {
  private child: ChildProcess | null = null;
  private wanted = false;
  private current: NetStatus = { state: 'stopped' };
  private lastJson = '';
  private failures: number[] = [];
  private restarts = 0;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;
  private socketPath: string | null = null;
  private socksHost: string | null = null;
  private socksPort: number | null = null;
  private networkJsonWritten = false;
  private fatal: string | null = null;
  private logFile: RotatingLog | null = null;
  private readonly platform: NodeJS.Platform;
  private readonly spawnFn: SpawnFn;
  private readonly cli: CliFn;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;

  constructor(private readonly opts: TailscaleManagerOptions) {
    super();
    this.platform = opts.platform ?? process.platform;
    this.spawnFn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
    this.cli = opts.cli ?? defaultCli;
    this.log = opts.log ?? ((m) => console.error(`[network] ${m}`));
    this.now = opts.now ?? Date.now;
  }

  // ------------------------------------------------------------------ paths

  private exe(name: 'tailscaled' | 'tailscale'): string {
    return join(this.opts.binDir, this.platform === 'win32' ? `${name}.exe` : name);
  }

  get tailscaledPath(): string {
    return this.exe('tailscaled');
  }

  private uid(): number {
    return this.opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : -1);
  }

  private env(): NodeJS.ProcessEnv {
    const base = this.opts.baseEnv ?? process.env;
    return scrubEnv(base, this.platform);
  }

  /** Environment for the daemon (ProcessManager): socket + SOCKS5 endpoint, or null when not running. */
  daemonEnv(): Record<string, string> | null {
    if (!this.socketPath || !this.socksHost || !this.socksPort) return null;
    return {
      AIRBRIDGE_NETWORK: 'embedded',
      AIRBRIDGE_TS_SOCKET: this.socketPath,
      AIRBRIDGE_TS_SOCKS5: this.socks5(),
    };
  }

  private socks5(): string {
    return this.socksHost === '::1' ? `[::1]:${this.socksPort}` : `127.0.0.1:${this.socksPort}`;
  }

  // ------------------------------------------------------------------ public API

  async start(): Promise<void> {
    if (this.stopping) await this.stopping;
    this.wanted = true;
    if (this.child || this.restartTimer) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    this.failures = [];
    this.restarts = 0;
    this.fatal = null;
    this.setStatus({ state: 'starting' });
    try {
      if (!fs.existsSync(this.tailscaledPath) || !fs.existsSync(this.exe('tailscale'))) {
        throw new Error('private network component is missing from this build');
      }
      ensurePrivateDir(this.opts.dataDir, this.platform, this.uid());
      ensurePrivateDir(join(this.opts.dataDir, 'tailscaled'), this.platform, this.uid());
      ensurePrivateDir(join(this.opts.dataDir, 'logs'), this.platform, this.uid());
      await this.cleanupStale();
      const sp = socketPathFor({
        dataDir: this.opts.dataDir,
        platform: this.platform,
        tmpdir: this.opts.tmpdir ?? osTmpdir(),
        uid: this.uid(),
        username: this.opts.username ?? safeUsername(),
      });
      if (sp.dir && sp.dir !== this.opts.dataDir) ensurePrivateDir(sp.dir, this.platform, this.uid());
      this.socketPath = sp.socket;
      this.socksHost = (await (this.opts.ipv6Loopback ?? (async () => (await probeListen('::1', 0)) !== null))()) ? '::1' : '127.0.0.1';
      this.socksPort = await (this.opts.pickPort ?? pickFreePort)(this.socksHost);
    } catch (e) {
      this.wanted = false;
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`start failed: ${msg}`);
      this.setStatus({ state: 'error', detail: 'Could not start the private network.' });
      return;
    }
    this.logFile ??= new RotatingLog(join(this.opts.dataDir, 'logs', 'tailscaled.log'));
    this.spawnChild();
    this.startHealth();
    await this.pollOnce();
  }

  async stop(): Promise<void> {
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
      this.markStopped();
      this.logFile?.close();
      this.setStatus({ state: 'stopped' });
    }
  }

  async status(): Promise<NetStatus> {
    if (this.wanted && this.child) await this.pollOnce();
    return { ...this.current };
  }

  /** Latest known status without querying tailscaled. */
  lastStatus(): NetStatus {
    return { ...this.current };
  }

  async up(authKeyFile: string, hostname: string, loginServer: string): Promise<void> {
    const socket = this.requireSocket();
    const res = await this.cli(
      this.exe('tailscale'),
      [
        `--socket=${socket}`,
        'up',
        '--reset',
        `--login-server=${loginServer}`,
        `--auth-key=file:${authKeyFile}`,
        `--hostname=${hostname}`,
        '--accept-routes=false',
        '--accept-dns=false',
        '--timeout=60s',
      ],
      { env: this.env(), timeoutMs: UP_TIMEOUT_MS, cwd: this.opts.dataDir },
    );
    if (res.code !== 0) {
      this.log(`join failed (exit ${res.code}): ${redact(res.stderr).slice(-300)}`);
      throw new Error('up_failed');
    }
    await this.pollOnce();
  }

  async logout(): Promise<void> {
    if (!this.socketPath || !this.child) return;
    const res = await this.cli(this.exe('tailscale'), [`--socket=${this.socketPath}`, 'logout'], {
      env: this.env(),
      timeoutMs: 30_000,
      cwd: this.opts.dataDir,
    });
    if (res.code !== 0) this.log(`logout exited ${res.code}: ${redact(res.stderr).slice(-200)}`);
    try {
      this.mergeNetworkJson({ login_server: null, enrolled_sub_hash: null });
    } catch {
      /* ignore */
    }
    await this.pollOnce();
  }

  /** enroll.ts hook: persist the enrollment (TailscaleManager owns network.json). */
  recordEnrollment(info: { loginServer: string; subHash: string }): void {
    this.mergeNetworkJson({ login_server: info.loginServer, enrolled_sub_hash: info.subHash });
  }

  // ------------------------------------------------------------------ internals

  private requireSocket(): string {
    if (!this.socketPath || !this.child) throw new Error('daemon_not_ready');
    return this.socketPath;
  }

  private setStatus(s: NetStatus): void {
    const json = JSON.stringify(s);
    this.current = s;
    if (json === this.lastJson) return;
    this.lastJson = json;
    this.emit('status', { ...s });
  }

  private spawnChild(): void {
    const argv = tailscaledArgv({
      dataDir: this.opts.dataDir,
      socket: this.socketPath!,
      socksHost: this.socksHost!,
      socksPort: this.socksPort!,
      platform: this.platform,
    });
    this.networkJsonWritten = false;
    this.fatal = null;
    let child: ChildProcess;
    try {
      child = this.spawnFn(this.tailscaledPath, argv, {
        env: this.env(),
        cwd: this.opts.dataDir,
        stdio: ['ignore', 'pipe', 'pipe'],
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
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.logFile?.write(redact(text));
      // F-10: a squatted SOCKS port is fatal for tailscaled; surface it instead of looping silently.
      if (/SOCKS5 listener:|socks5.*address already in use/i.test(text)) this.fatal = 'Private network port is in use.';
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', (err) => {
      this.log(`tailscaled error: ${err.message}`);
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
  }

  private onExit(code: number | null, signal?: NodeJS.Signals | null): void {
    if (!this.wanted) return;
    this.markStopped();
    const t = this.now();
    this.failures = this.failures.filter((f) => t - f < FAILURE_WINDOW_MS);
    this.failures.push(t);
    this.log(`tailscaled exited unexpectedly (code=${code} signal=${signal ?? null})`);
    if (this.failures.length >= MAX_FAILURES) {
      this.wanted = false;
      this.stopHealth();
      this.setStatus({ state: 'error', detail: this.fatal ?? 'The private network keeps stopping.' });
      return;
    }
    this.restarts += 1;
    const delay = (this.opts.backoffMs ?? defaultBackoffMs)(this.restarts);
    // Transient: stay in 'starting' (the UI treats 'error' as a full-screen error).
    this.setStatus({ state: 'starting', detail: 'Reconnecting…' });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.wanted && !this.child && !this.stopping) {
        this.spawnChild();
        void this.pollOnce();
      }
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

  private clearTimers(): void {
    this.stopHealth();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
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
    const child = this.child;
    if (!this.wanted || !child || !this.socketPath) return;
    const res = await this.cli(this.exe('tailscale'), [`--socket=${this.socketPath}`, 'status', '--json'], {
      env: this.env(),
      timeoutMs: CLI_TIMEOUT_MS,
      cwd: this.opts.dataDir,
    }).catch((): CliResult => ({ code: null, stdout: '', stderr: '' }));
    if (this.child !== child || !this.wanted) return;
    const out = res.stdout.trim();
    if (!out.startsWith('{')) {
      // Not answering yet (socket not up) -> still starting.
      if (this.current.state !== 'error') this.setStatus({ state: 'starting' });
      return;
    }
    const st = parseStatus(out);
    if (st.state !== 'starting' && st.state !== 'error' && !this.networkJsonWritten) {
      try {
        this.writeNetworkJson(child.pid ?? 0);
        this.networkJsonWritten = true;
      } catch (e) {
        this.log(`could not write ${NETWORK_JSON}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.setStatus(st);
  }

  // ---- network.json (0600, atomic) -------------------------------------------------------

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

  private writeNetworkJson(pid: number): void {
    const prev = this.readNetworkJson() ?? {};
    this.atomicWrite({
      v: 1,
      socket: this.socketPath,
      socks5: this.socks5(),
      pid,
      bin: this.tailscaledPath,
      login_server: prev.login_server ?? null,
      enrolled_sub_hash: prev.enrolled_sub_hash ?? null,
    });
  }

  private mergeNetworkJson(patch: Record<string, unknown>): void {
    const prev = this.readNetworkJson() ?? { v: 1 };
    this.atomicWrite({ ...prev, ...patch, v: 1 });
  }

  /** After stop/crash the pid is gone; keep the file so the MCP process can say "network is off". */
  private markStopped(): void {
    this.networkJsonWritten = false;
    const prev = this.readNetworkJson();
    if (prev && prev.pid) {
      try {
        this.atomicWrite({ ...prev, pid: null });
      } catch {
        /* ignore */
      }
    }
  }

  // ---- stale cleanup ----------------------------------------------------------------------

  /** Kill a tailscaled left by a crashed previous run: only if its pid is alive AND it is our binary. */
  async cleanupStale(): Promise<'killed' | 'none' | 'ignored'> {
    const prev = this.readNetworkJson();
    const pid = prev?.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) return 'none';
    if (!(this.opts.isPidAlive ?? defaultIsPidAlive)(pid)) return 'none';
    const exe = await (this.opts.processExePath ?? ((p: number) => processExePath(p, this.platform)))(pid).catch(() => null);
    if (!exe || !samePath(exe, this.tailscaledPath, this.platform)) {
      this.log(`pid ${pid} from ${NETWORK_JSON} is not our tailscaled (pid reuse); leaving it alone`);
      return 'ignored';
    }
    this.log(`stopping leftover tailscaled (pid ${pid})`);
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

function safeUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USERNAME ?? process.env.USER ?? 'user';
  }
}

async function pickFreePort(host: string): Promise<number> {
  const p = await probeListen(host, 0);
  if (!p) throw new Error('no free loopback port');
  return p;
}

/** Remove anything that looks like a Tailscale/Headscale key from text bound for logs. */
export function redact(text: string): string {
  return text.replace(/(?:hs|ts)key-[\w-]+/g, '<redacted-key>');
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

// ------------------------------------------------------------------ system Tailscale (preview mode)

/** Fixed, vendor-neutral copy: the renderer adds its own preview hint (src/renderer/lib/preview.ts). */
export const SYSTEM_NET_ERROR_DETAIL = "AirBridge can't reach the network on this computer.";

/**
 * NetStatus for a daemon running with AIRBRIDGE_NETWORK=system (the user's own Tailscale; PHASE3_PLAN.md §8).
 * No tailscaled is supervised here: the state is derived from the daemon's GET /status.
 *   no daemon            -> lifecycle starting: 'starting'; running (no /status yet): 'connecting'; else 'stopped'
 *   tailnet_ip present   -> 'connected' (+ ip)
 *   degraded, no ip      -> 'error' (Tailscale missing / logged out / not running). The daemon's reason is
 *                           NOT forwarded (it can carry paths/CLI output); callers log it main-side.
 *   neither yet          -> 'connecting'
 */
export function systemNetStatus(
  status: { tailnet_ip: string | null; inbox: { degraded_reason: string | null } } | null,
  lifecycle: { phase: string },
): NetStatus {
  if (!status) {
    if (lifecycle.phase === 'starting') return { state: 'starting' };
    if (lifecycle.phase === 'running') return { state: 'connecting' };
    return { state: 'stopped' };
  }
  if (status.tailnet_ip) return { state: 'connected', ip: status.tailnet_ip };
  if (status.inbox?.degraded_reason) return { state: 'error', detail: SYSTEM_NET_ERROR_DETAIL };
  return { state: 'connecting' };
}
