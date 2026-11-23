/**
 * NetManager (PHASE3_PLAN.md §9) against a fake airbridge-net (tests/fixtures/fake-airbridge-net.js):
 * stdin-only secrets, empty argv, scrubbed env, READY parsing, health -> NetStatus, network.json v2,
 * crash restart without the key, give-up after 5 failures, stop escalation, stale-pid cleanup,
 * logout/wipe, log redaction.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NetManager,
  parseNetReady,
  parseSidecarStatus,
  processExePath,
  redact,
  scrubEnv,
  type NetManagerOptions,
} from '../src/main/network/NetManager';

const isWin = process.platform === 'win32';
const FIX = resolve(__dirname, 'fixtures');
const KEY = ['hskey', 'auth', 'abcdefghijkl', 'offlinetestsecret0000'].join('-');
const LAUNCH = { controlUrl: 'https://hs.test.example', hostname: 'airbridge-a1' };

let base: string;
let D: string;
let binDir: string;
const managers: NetManager[] = [];
const extraPids: number[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

function make(o: Partial<NetManagerOptions> = {}): NetManager {
  const nm = new NetManager({
    binDir,
    dataDir: D,
    baseEnv: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      AIRBRIDGE_SECRET: 'must-not-leak',
      TS_AUTHKEY: 'must-not-leak',
      CLERK_TOKEN: 'x',
      HTTPS_PROXY: 'http://proxy.corp.example:3128',
    },
    healthIntervalMs: 100,
    stopTimeoutMs: 400,
    readyTimeoutMs: 3000,
    backoffMs: () => 30,
    log: () => undefined,
    ...o,
  });
  managers.push(nm);
  return nm;
}

interface Rec {
  argv: string[];
  env: Record<string, string>;
  config: Record<string, unknown>;
  pid: number;
}

function records(): Rec[] {
  return fs
    .readdirSync(D)
    .filter((n) => /^fake-net\.\d+\.json$/.test(n))
    .map((n) => JSON.parse(fs.readFileSync(join(D, n), 'utf8')) as Rec)
    .sort((a, b) => a.pid - b.pid);
}

function behave(b: Record<string, unknown>): void {
  fs.mkdirSync(D, { recursive: true, mode: 0o700 });
  fs.writeFileSync(join(D, 'fake-net-behavior.json'), JSON.stringify(b));
}

const networkJson = () => JSON.parse(fs.readFileSync(join(D, 'network.json'), 'utf8')) as Record<string, unknown>;

beforeEach(() => {
  base = fs.mkdtempSync(join(tmpdir(), 'abnm'));
  D = join(base, 'd');
  binDir = join(base, 'bin');
  fs.mkdirSync(binDir);
  fs.copyFileSync(join(FIX, 'fake-airbridge-net.js'), join(binDir, 'airbridge-net'));
  fs.chmodSync(join(binDir, 'airbridge-net'), 0o755);
});

afterEach(async () => {
  for (const nm of managers.splice(0)) await nm.stop();
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
  it('parses READY lines strictly', () => {
    expect(parseNetReady('AIRBRIDGE_NET_READY {"port":5000,"pid":12,"host":"::1"}')).toEqual({ port: 5000, pid: 12, host: '::1' });
    expect(parseNetReady('AIRBRIDGE_NET_READY {"port":5000,"pid":12,"host":"127.0.0.1"}')).toMatchObject({ host: '127.0.0.1' });
    for (const bad of [
      'AIRBRIDGE_NET_READY {"port":5000,"pid":12,"host":"0.0.0.0"}',
      'AIRBRIDGE_NET_READY {"port":0,"pid":12,"host":"::1"}',
      'AIRBRIDGE_NET_READY {"port":5000,"host":"::1"}',
      'AIRBRIDGE_NET_READY nope',
      'AIRBRIDGE_READY {"control_port":5000,"pid":12}',
    ]) {
      expect(parseNetReady(bad)).toBeNull();
    }
  });

  it('maps sidecar /status to NetStatus without forwarding sidecar text', () => {
    expect(parseSidecarStatus({ state: 'connected', self: { ip: '100.64.0.7' } })).toEqual({ state: 'connected', ip: '100.64.0.7' });
    expect(parseSidecarStatus({ state: 'connected', self: {} })).toEqual({ state: 'connecting' });
    expect(parseSidecarStatus({ state: 'needs_login', self: { ip: '' } })).toEqual({ state: 'needs_login' });
    const err = parseSidecarStatus({ state: 'error', error: '/home/x/secret path' });
    expect(err.state).toBe('error');
    expect(JSON.stringify(err)).not.toContain('/home');
    expect(parseSidecarStatus('garbage').state).toBe('error');
  });

  it('scrubs the environment to an allow-list (+ proxies, + TS_NO_LOGS_NO_SUPPORT)', () => {
    const env = scrubEnv({ PATH: '/bin', TS_AUTHKEY: 'k', AIRBRIDGE_SECRET: 's', HTTPS_PROXY: 'http://p:1', SystemRoot: 'C:\\W' }, 'linux');
    expect(env).toEqual({ PATH: '/bin', HTTPS_PROXY: 'http://p:1', TS_NO_LOGS_NO_SUPPORT: 'true' });
    expect(scrubEnv({ SystemRoot: 'C:\\W' }, 'win32').SystemRoot).toBe('C:\\W');
  });

  it('redacts keys and URLs', () => {
    expect(redact(`x ${KEY} https://hs.example.com/register/abc y`)).toBe('x <redacted-key> <url> y');
  });
});

describe.skipIf(isWin)('NetManager with a fake sidecar', () => {
  it('first join: key only on stdin, empty argv, scrubbed env, READY -> connected, network.json v2 0600', async () => {
    const nm = make();
    const seen: string[] = [];
    nm.on('status', (s) => seen.push(s.state));
    await nm.start({ ...LAUNCH, authKey: KEY });
    const st = await until(async () => {
      const s = await nm.status();
      return s.state === 'connected' ? s : null;
    });
    expect(st).toEqual({ state: 'connected', ip: '100.64.0.7' });
    expect(seen).toContain('starting');

    const [rec] = records();
    expect(rec!.argv).toEqual([]);
    expect(rec!.config).toMatchObject({
      auth_key: KEY,
      control_url: LAUNCH.controlUrl,
      hostname: LAUNCH.hostname,
      state_dir: join(D, 'tsnet'),
      parent_pid: process.pid,
    });
    expect(String(rec!.config.control_token)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(rec!.env)).not.toContain(KEY);
    expect(rec!.env.AIRBRIDGE_SECRET).toBeUndefined();
    expect(rec!.env.TS_AUTHKEY).toBeUndefined();
    expect(rec!.env.CLERK_TOKEN).toBeUndefined();
    expect(rec!.env.TS_NO_LOGS_NO_SUPPORT).toBe('true');

    const j = networkJson();
    expect(j).toMatchObject({ v: 2, mode: 'sidecar', pid: rec!.pid, bin: join(binDir, 'airbridge-net') });
    expect(j.control_token).toBe(rec!.config.control_token);
    expect(String(j.control_url_local)).toMatch(/^http:\/\/(\[::1\]|127\.0\.0\.1):\d+$/);
    expect(JSON.stringify(j)).not.toContain(KEY);
    expect(fs.statSync(join(D, 'network.json')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(join(D, 'tsnet')).mode & 0o777).toBe(0o700);

    const env = nm.daemonEnv()!;
    expect(env).toEqual({ AIRBRIDGE_NETWORK: 'sidecar', AIRBRIDGE_NET_URL: j.control_url_local, AIRBRIDGE_NET_TOKEN: j.control_token });
  });

  it('never writes the key or the login URL to its log file (redaction)', async () => {
    const nm = make();
    await nm.start({ ...LAUNCH, authKey: KEY });
    await nm.stop();
    const log = fs.readFileSync(join(D, 'logs', 'airbridge-net.log'), 'utf8');
    expect(log).toContain('<redacted-key>');
    expect(log).not.toMatch(/hskey-|register\/abc|https?:\/\//);
  });

  it('without state or key the sidecar reports needs_login; same launch is idempotent', async () => {
    const nm = make();
    await nm.start(LAUNCH);
    expect(nm.hasState()).toBe(false);
    expect((await until(async () => ((await nm.status()).state === 'needs_login' ? 1 : 0)))).toBe(1);
    await nm.start(LAUNCH); // no respawn
    expect(records()).toHaveLength(1);
    expect(records()[0]!.config.auth_key).toBeUndefined();
  });

  it('a launch with a key respawns; a crash restart never re-sends the key', async () => {
    const nm = make();
    await nm.start(LAUNCH);
    await nm.start({ ...LAUNCH, authKey: KEY });
    expect(records()).toHaveLength(2);
    const second = records()[1]!;
    expect(second.config.auth_key).toBe(KEY);
    process.kill(second.pid, 'SIGKILL');
    await until(() => records().length === 3);
    expect(records()[2]!.config.auth_key).toBeUndefined();
    await until(async () => ((await nm.status()).state === 'connected' ? 1 : 0)); // state persisted
    // the respawned sidecar has a new endpoint for the daemon
    expect(nm.daemonEnv()!.AIRBRIDGE_NET_TOKEN).toBe(records()[2]!.config.control_token);
  });

  it('gives up after 5 failures within 2 minutes -> error', async () => {
    behave({ crash: true });
    const nm = make();
    await nm.start(LAUNCH);
    await until(() => nm.lastStatus().state === 'error', 8000);
    expect(nm.lastStatus().detail).toBe('The private network keeps stopping.');
    expect(records().length).toBe(5);
  });

  it('kills a sidecar that never reports READY', async () => {
    behave({ noReady: true });
    const nm = make({ readyTimeoutMs: 300 });
    void nm.start(LAUNCH);
    await until(() => records().length >= 2, 6000);
  });

  it('stop escalates SIGTERM -> SIGKILL and marks network.json stopped', async () => {
    behave({ ignoreTerm: true });
    const nm = make();
    await nm.start(LAUNCH);
    const pid = records()[0]!.pid;
    const t0 = Date.now();
    await nm.stop();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
    expect(alive(pid)).toBe(false);
    expect(networkJson()).toMatchObject({ pid: null, control_token: null });
    expect(nm.daemonEnv()).toBeNull();
    expect(nm.lastStatus().state).toBe('stopped');
  });

  it('logout calls the sidecar and clears the enrollment record; wipeState deletes the node state', async () => {
    const nm = make();
    await nm.start({ ...LAUNCH, authKey: KEY });
    nm.recordEnrollment({ loginServer: LAUNCH.controlUrl, subHash: 'abc' });
    expect(nm.enrollment()).toEqual({ loginServer: LAUNCH.controlUrl, subHash: 'abc' });
    await nm.logout();
    expect(fs.readdirSync(D).some((n) => n.endsWith('.logout'))).toBe(true);
    expect(nm.enrollment()).toEqual({ loginServer: null, subHash: null });
    expect(nm.hasState()).toBe(true);
    await nm.wipeState();
    expect(nm.hasState()).toBe(false);
    expect(nm.isRunning()).toBe(false);
  });

  it('enrollment record survives respawns (network.json rewrite keeps it)', async () => {
    const nm = make();
    await nm.start(LAUNCH);
    nm.recordEnrollment({ loginServer: LAUNCH.controlUrl, subHash: 'h' });
    await nm.start({ ...LAUNCH, authKey: KEY });
    expect(nm.enrollment()).toEqual({ loginServer: LAUNCH.controlUrl, subHash: 'h' });
  });

  it('missing binary -> error without spawning', async () => {
    fs.rmSync(join(binDir, 'airbridge-net'));
    const nm = make();
    await nm.start(LAUNCH);
    expect(nm.lastStatus()).toEqual({ state: 'error', detail: 'Could not start the private network.' });
  });

  it('stale cleanup: kills a leftover sidecar of OUR binary, leaves a reused pid alone', async () => {
    fs.mkdirSync(D, { recursive: true, mode: 0o700 });
    const leftover = spawn(join(binDir, 'airbridge-net'), [], { cwd: D, stdio: ['pipe', 'ignore', 'ignore'] });
    extraPids.push(leftover.pid!);
    const nm = make({ processExePath: async () => join(binDir, 'airbridge-net') });
    fs.writeFileSync(join(D, 'network.json'), JSON.stringify({ v: 2, mode: 'sidecar', pid: leftover.pid }), { mode: 0o600 });
    expect(await nm.cleanupStale()).toBe('killed');
    await until(() => !alive(leftover.pid!) || leftover.exitCode !== null || leftover.signalCode !== null);

    const other = spawn(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { stdio: 'ignore' });
    extraPids.push(other.pid!);
    fs.writeFileSync(join(D, 'network.json'), JSON.stringify({ v: 2, mode: 'sidecar', pid: other.pid }), { mode: 0o600 });
    const nm2 = make();
    expect(await nm2.cleanupStale()).toBe('ignored');
    expect(alive(other.pid!)).toBe(true);
    expect(await processExePath(other.pid!, process.platform)).toBeTruthy();
  });

  it('refuses a group/other-writable or foreign data dir (F-8)', async () => {
    fs.mkdirSync(D, { recursive: true });
    const nm = make({ uid: (process.getuid?.() ?? 0) + 4242 });
    await nm.start(LAUNCH);
    expect(nm.lastStatus().state).toBe('error');
    expect(records()).toHaveLength(0);
  });
});
