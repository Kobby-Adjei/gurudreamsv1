import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NetStatus } from '../src/shared/types';
import { ensureEnrolled, EnrollError } from '../src/main/network/enroll';
import {
  ensurePrivateDir,
  parseStatus,
  processExePath,
  socketPathFor,
  tailscaledArgv,
  TailscaleManager,
  type TailscaleManagerOptions,
} from '../src/main/network/TailscaleManager';

const isWin = process.platform === 'win32';
const FIX = resolve(__dirname, 'fixtures');

let base: string;
let D: string;
let binDir: string;
const managers: TailscaleManager[] = [];
const extraPids: number[] = [];

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function until<T>(fn: () => T | Promise<T>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout');
    await sleep(25);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function make(o: Partial<TailscaleManagerOptions> = {}): TailscaleManager {
  const tm = new TailscaleManager({
    binDir,
    dataDir: D,
    baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, AIRBRIDGE_SECRET: 'must-not-leak', CLERK_TOKEN: 'x' },
    healthIntervalMs: 100,
    stopTimeoutMs: 400,
    backoffMs: () => 30,
    log: () => undefined,
    ...o,
  });
  managers.push(tm);
  return tm;
}

function records(): Array<{ argv: string[]; env: Record<string, string>; cwd: string; pid: number }> {
  return fs
    .readdirSync(D)
    .filter((n) => n.startsWith('fake-tailscaled.'))
    .map((n) => JSON.parse(fs.readFileSync(join(D, n), 'utf8')));
}

beforeEach(() => {
  base = fs.mkdtempSync(join(tmpdir(), 'abtm'));
  D = join(base, 'd');
  binDir = join(base, 'bin');
  fs.mkdirSync(binDir);
  fs.copyFileSync(join(FIX, 'fake-tailscaled.js'), join(binDir, 'tailscaled'));
  fs.copyFileSync(join(FIX, 'fake-tailscale.js'), join(binDir, 'tailscale'));
  fs.chmodSync(join(binDir, 'tailscaled'), 0o755);
  fs.chmodSync(join(binDir, 'tailscale'), 0o755);
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stop()));
  for (const pid of extraPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  fs.rmSync(base, { recursive: true, force: true });
});

describe('pure helpers', () => {
  it('argv contract: fixed order, SOCKS on loopback only', () => {
    expect(tailscaledArgv({ dataDir: '/D', socket: '/D/tailscaled.sock', socksHost: '::1', socksPort: 4242, platform: 'linux' })).toEqual([
      '--tun=userspace-networking',
      '--statedir=/D/tailscaled',
      '--socket=/D/tailscaled.sock',
      '--socks5-server=[::1]:4242',
      '--port=0',
      '--no-logs-no-support',
    ]);
    expect(tailscaledArgv({ dataDir: '/D', socket: '/s', socksHost: '127.0.0.1', socksPort: 1, platform: 'darwin' })[3]).toBe(
      '--socks5-server=127.0.0.1:1',
    );
    const win = tailscaledArgv({ dataDir: 'C:\\D', socket: '\\\\.\\pipe\\x', socksHost: '::1', socksPort: 1, platform: 'win32' });
    expect(win.at(-1)).toBe('--windows-mode=dev');
  });

  it('socket path: in D, tmp fallback past 100 bytes, Windows per-user + per-launch pipe', () => {
    expect(socketPathFor({ dataDir: '/home/a/.local/share/airbridge', platform: 'linux', tmpdir: '/tmp', uid: 501, username: 'a' }).socket).toBe(
      '/home/a/.local/share/airbridge/tailscaled.sock',
    );
    const long = '/Users/' + 'x'.repeat(80) + '/Library/Application Support/AirBridge';
    expect(socketPathFor({ dataDir: long, platform: 'darwin', tmpdir: '/var/folders/T', uid: 501, username: 'x' })).toEqual({
      socket: '/var/folders/T/airbridge-501/ts.sock',
      dir: '/var/folders/T/airbridge-501',
    });
    const a = socketPathFor({ dataDir: 'C:\\D', platform: 'win32', tmpdir: 'C:\\T', uid: -1, username: 'Ann' });
    const b = socketPathFor({ dataDir: 'C:\\D', platform: 'win32', tmpdir: 'C:\\T', uid: -1, username: 'Ann' });
    expect(a.socket).toMatch(/^\\\\\.\\pipe\\airbridge-tailscaled-[0-9a-f]{12}-[0-9a-f]{8}$/);
    expect(a.socket.slice(0, -9)).toBe(b.socket.slice(0, -9)); // same user part
    expect(a.socket).not.toBe(b.socket); // random per launch
  });

  it('parseStatus maps backend states', () => {
    const s = (BackendState: string, ips: string[] = []) => parseStatus(JSON.stringify({ BackendState, Self: { TailscaleIPs: ips } }));
    expect(s('Running', ['100.64.0.3', 'fd7a::3'])).toEqual({ state: 'connected', ip: '100.64.0.3' });
    expect(s('NeedsLogin').state).toBe('needs_login');
    expect(s('NoState').state).toBe('needs_login');
    expect(s('Starting').state).toBe('connecting');
    expect(parseStatus('nope').state).toBe('error');
  });

  it.skipIf(isWin)('ensurePrivateDir: 0700, refuses symlinks', () => {
    const d = join(base, 'p');
    ensurePrivateDir(d, 'linux', process.getuid!());
    expect(fs.statSync(d).mode & 0o777).toBe(0o700);
    fs.chmodSync(d, 0o755);
    ensurePrivateDir(d, 'linux', process.getuid!());
    expect(fs.statSync(d).mode & 0o777).toBe(0o700);
    fs.symlinkSync(d, join(base, 'link'));
    expect(() => ensurePrivateDir(join(base, 'link'), 'linux', process.getuid!())).toThrow(/unsafe/);
    expect(() => ensurePrivateDir(d, 'linux', process.getuid!() + 1)).toThrow(/another user/);
  });

  it.skipIf(process.platform !== 'linux')('processExePath reads /proc', async () => {
    expect(await processExePath(process.pid, 'linux')).toBe(fs.realpathSync(process.execPath));
  });
});

describe.skipIf(isWin)('TailscaleManager with a fake tailscaled', () => {
  it('spawns with the argv contract, scrubbed env, cwd=D; writes network.json after a healthy status', async () => {
    const tm = make();
    const seen: NetStatus[] = [];
    tm.on('status', (s) => seen.push(s));
    await tm.start();
    const st = await until(async () => ((await tm.status()).state === 'needs_login' ? tm.lastStatus() : null));
    expect(st!.state).toBe('needs_login');
    const [rec] = records();
    expect(rec!.cwd).toBe(fs.realpathSync(D));
    const sock = join(D, 'tailscaled.sock');
    expect(rec!.argv.slice(0, 3)).toEqual(['--tun=userspace-networking', `--statedir=${join(D, 'tailscaled')}`, `--socket=${sock}`]);
    expect(rec!.argv[3]).toMatch(/^--socks5-server=(\[::1\]|127\.0\.0\.1):\d+$/);
    expect(rec!.argv.slice(4)).toEqual(['--port=0', '--no-logs-no-support']);
    expect(Object.keys(rec!.env).sort()).toEqual(expect.arrayContaining(['PATH', 'TS_NO_LOGS_NO_SUPPORT']));
    expect(rec!.env.AIRBRIDGE_SECRET).toBeUndefined();
    expect(rec!.env.CLERK_TOKEN).toBeUndefined();
    expect(rec!.env.TS_NO_LOGS_NO_SUPPORT).toBe('true');

    const nj = JSON.parse(fs.readFileSync(join(D, 'network.json'), 'utf8'));
    expect(nj).toMatchObject({ v: 1, socket: sock, pid: rec!.pid, bin: join(binDir, 'tailscaled') });
    expect(nj.socks5).toBe(rec!.argv[3]!.slice('--socks5-server='.length));
    expect(fs.statSync(join(D, 'network.json')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(D).mode & 0o777).toBe(0o700);
    expect(tm.daemonEnv()).toEqual({ AIRBRIDGE_NETWORK: 'embedded', AIRBRIDGE_TS_SOCKET: sock, AIRBRIDGE_TS_SOCKS5: nj.socks5 });
    expect(seen.map((s) => s.state)).toContain('starting');
    expect(fs.existsSync(join(D, 'logs'))).toBe(true);
  });

  it('up() passes the key only as file:, reaches connected, keeps enrollment fields across restarts', async () => {
    const tm = make();
    await tm.start();
    await until(async () => (await tm.status()).state === 'needs_login');
    const keyFile = join(D, '.authkey-test');
    fs.writeFileSync(keyFile, 'hskey-auth-SECRETVALUE-1234567890', { mode: 0o600 });
    await tm.up(keyFile, 'airbridge-box', 'https://hs.example');
    const up = JSON.parse(fs.readFileSync(join(D, 'fake-up.json'), 'utf8'));
    expect(up.keyFileReadable).toBe(true);
    expect(up.args).toEqual([
      `--socket=${join(D, 'tailscaled.sock')}`,
      'up',
      '--reset',
      '--login-server=https://hs.example',
      `--auth-key=file:${keyFile}`,
      '--hostname=airbridge-box',
      '--accept-routes=false',
      '--accept-dns=false',
      '--timeout=60s',
    ]);
    expect(JSON.stringify(up.args)).not.toContain('SECRETVALUE');
    expect(await tm.status()).toEqual({ state: 'connected', ip: '100.64.0.7' });

    tm.recordEnrollment({ loginServer: 'https://hs.example', subHash: 'ab'.repeat(32) });
    await tm.stop();
    expect(JSON.parse(fs.readFileSync(join(D, 'network.json'), 'utf8')).pid).toBeNull();
    await tm.start();
    await until(async () => (await tm.status()).state === 'connected');
    const nj = JSON.parse(fs.readFileSync(join(D, 'network.json'), 'utf8'));
    expect(nj.login_server).toBe('https://hs.example');
    expect(nj.enrolled_sub_hash).toBe('ab'.repeat(32));
    expect(typeof nj.pid).toBe('number');

    await tm.logout();
    expect((await tm.status()).state).toBe('needs_login');
  });

  it('real ensureEnrolled + TailscaleManager: key file deleted even when up fails; never logged', async () => {
    const tm = make();
    await tm.start();
    await until(async () => (await tm.status()).state === 'needs_login');
    const logs: string[] = [];
    const fetchFn = (async () =>
      new Response(JSON.stringify({ auth_key: 'hskey-auth-' + 'k'.repeat(40), login_server: 'https://hs.example' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const run = () =>
      ensureEnrolled({
        tm,
        getAuthToken: async () => 'clerk-token',
        getUserSub: () => 'user_1',
        licenseUrl: 'https://license.example',
        dataDir: D,
        fetch: fetchFn,
        log: (m) => logs.push(m),
        pollIntervalMs: 20,
      });
    // Make the fake CLI's `up` fail (after the key file was written).
    const origUp = tm.up.bind(tm);
    tm.up = async (f, h, l) => {
      fs.writeFileSync(join(D, 'fake-ts-state'), 'FailUp');
      return origUp(f, h, l);
    };
    await expect(run()).rejects.toBeInstanceOf(EnrollError);
    expect(fs.readdirSync(D).filter((n) => n.startsWith('.authkey-'))).toEqual([]);
    expect(logs.join('\n')).not.toContain('kkkk');
    // Second attempt succeeds and is then idempotent (no new key).
    tm.up = origUp;
    fs.writeFileSync(join(D, 'fake-ts-state'), 'NeedsLogin');
    await until(async () => (await tm.status()).state === 'needs_login');
    expect(await run()).toBe('enrolled');
    expect(await run()).toBe('already_enrolled');
    expect(fs.readdirSync(D).filter((n) => n.startsWith('.authkey-'))).toEqual([]);
    const logPath = join(D, 'logs', 'tailscaled.log');
    if (fs.existsSync(logPath)) expect(fs.readFileSync(logPath, 'utf8')).not.toContain('kkkk');
  });

  it('restarts with backoff and only reports error after 5 failures in 2 minutes', async () => {
    fs.mkdirSync(D, { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(D, 'fake-mode'), 'crash');
    const tm = make();
    const states: string[] = [];
    tm.on('status', (s) => states.push(s.state));
    await tm.start();
    await until(() => tm.lastStatus().state === 'error', 8000);
    expect(records().length).toBe(5);
    expect(states.filter((s) => s === 'error')).toHaveLength(1);
    expect(states.indexOf('error')).toBe(states.length - 1); // transient crashes stayed 'starting'
    expect(states).not.toContain('connected');
  });

  it('stop escalates SIGTERM -> SIGKILL when tailscaled ignores SIGTERM', async () => {
    fs.mkdirSync(D, { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(D, 'fake-mode'), 'ignore-term');
    const tm = make();
    await tm.start();
    await until(async () => (await tm.status()).state === 'needs_login');
    const pid = records()[0]!.pid;
    const t0 = Date.now();
    await tm.stop();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
    await until(() => !alive(pid), 3000);
    expect(tm.lastStatus().state).toBe('stopped');
  });

  it('stale cleanup kills our leftover tailscaled but ignores a reused pid', async () => {
    fs.mkdirSync(D, { recursive: true, mode: 0o700 });
    const leftover = spawn(join(binDir, 'tailscaled'), ['--socket=' + join(base, 'old.sock')], { cwd: base, stdio: 'ignore' });
    const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    extraPids.push(leftover.pid!, other.pid!);
    await sleep(200);
    const write = (pid: number) =>
      fs.writeFileSync(join(D, 'network.json'), JSON.stringify({ v: 1, pid, bin: join(binDir, 'tailscaled') }), { mode: 0o600 });

    // pid reuse: alive, but not our binary -> untouched
    write(other.pid!);
    const tm1 = make({ processExePath: async () => '/usr/bin/something-else' });
    expect(await tm1.cleanupStale()).toBe('ignored');
    expect(alive(other.pid!)).toBe(true);

    // our binary -> killed
    write(leftover.pid!);
    const tm2 = make({ processExePath: async () => join(binDir, 'tailscaled') });
    expect(await tm2.cleanupStale()).toBe('killed');
    await until(() => !alive(leftover.pid!) || leftover.exitCode !== null || leftover.signalCode !== null, 4000);

    // dead pid -> nothing
    write(999_999);
    expect(await make({ isPidAlive: () => false }).cleanupStale()).toBe('none');
  });

  it('missing binaries -> error state, nothing spawned', async () => {
    const tm = make({ binDir: join(base, 'nope') });
    await tm.start();
    expect(tm.lastStatus().state).toBe('error');
    expect(tm.daemonEnv()).toBeNull();
  });
});
