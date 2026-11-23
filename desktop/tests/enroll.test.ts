import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureEnrolled,
  EnrollError,
  normalizeServerUrl,
  sanitizeHostname,
  subHash,
  type EnsureEnrolledOptions,
  type TailscaleManagerLike,
} from '../src/main/network/enroll';
import type { NetStatus } from '../src/shared/types';

const SUB = 'user_2abcDEF123';
const OTHER = 'user_9zzzOTHER77';
const LICENSE = 'https://license.test.example';
const LOGIN = 'https://hs.test.example';
// Built at runtime so secret scanners never see a key-shaped literal.
const KEY = ['hskey', 'auth', 'abcdefghijkl', 'offlinetestsecret0000'].join('-');

class FakeTm implements TailscaleManagerLike {
  state: NetStatus = { state: 'needs_login' };
  calls: string[] = [];
  upArgs: Array<{ file: string; hostname: string; loginServer: string; content: string; mode: number }> = [];
  failUp = false;
  async status() {
    return { ...this.state };
  }
  async up(file: string, hostname: string, loginServer: string) {
    this.calls.push('up');
    // The key must exist (0600) while tailscale reads it.
    const content = readFileSync(file, 'utf8');
    this.upArgs.push({ file, hostname, loginServer, content, mode: statSync(file).mode & 0o777 });
    if (this.failUp) throw new Error(`tailscale up failed: backend error`);
    this.state = { state: 'connected', ip: '100.64.0.2' };
  }
  async logout() {
    this.calls.push('logout');
    this.state = { state: 'needs_login' };
  }
}

let dir: string;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ab-enroll-'));
  logs = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function keyServer(status = 200, body: unknown = { auth_key: KEY, login_server: LOGIN, expires_at: 1 }) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
}

function opts(tm: FakeTm, over: Partial<EnsureEnrolledOptions> = {}): EnsureEnrolledOptions {
  return {
    tm,
    getAuthToken: async () => 'clerk.jwt.token',
    getUserSub: () => SUB,
    licenseUrl: LICENSE,
    dataDir: dir,
    deviceName: "Jane's MacBook-Pro.local",
    fetch: keyServer() as unknown as typeof fetch,
    log: (m) => void logs.push(m),
    readyTimeoutMs: 200,
    pollIntervalMs: 5,
    ...over,
  };
}

const writeNetworkJson = (o: Record<string, unknown>) =>
  writeFileSync(join(dir, 'network.json'), JSON.stringify({ v: 1, socket: '/s', socks5: '127.0.0.1:1', pid: 1, bin: '/b', ...o }));
const readNetworkJson = () => JSON.parse(readFileSync(join(dir, 'network.json'), 'utf8'));
const keyFiles = () => readdirSync(dir).filter((n) => n.startsWith('.authkey-'));

describe('sanitizeHostname', () => {
  it.each([
    ["Jane's MacBook-Pro.local", 'airbridge-janes-macbook-pro'],
    ['DESKTOP-ABC123', 'airbridge-desktop-abc123'],
    ['Zoë’s  Mac__mini', 'airbridge-zoes-mac-mini'],
    ['---', 'airbridge-device'],
    ['', 'airbridge-device'],
    ['airbridge-studio', 'airbridge-studio'],
    ['$(rm -rf /);evil', 'airbridge-rm-rf-evil'],
    ['x'.repeat(80), `airbridge-${'x'.repeat(50)}`],
    [`${'a'.repeat(49)}-b`, `airbridge-${'a'.repeat(49)}`],
  ])('%j -> %s', (raw, want) => {
    const h = sanitizeHostname(raw);
    expect(h).toBe(want);
    expect(h).toMatch(/^airbridge-[a-z0-9-]{1,50}$/);
    expect(h.endsWith('-')).toBe(false);
  });
});

describe('normalizeServerUrl', () => {
  it('accepts https and localhost http only, strips trailing slash', () => {
    expect(normalizeServerUrl('https://hs.example.com/')).toBe('https://hs.example.com');
    expect(normalizeServerUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(normalizeServerUrl('http://hs.example.com')).toBeNull();
    expect(normalizeServerUrl('https://u:p@hs.example.com')).toBeNull();
    expect(normalizeServerUrl('https://hs.example.com/?x=1')).toBeNull();
    expect(normalizeServerUrl(5)).toBeNull();
  });
});

describe('ensureEnrolled', () => {
  it('fresh device: fetches a key, writes it 0600, calls up with file+hostname+login server, deletes the file, records enrollment', async () => {
    const tm = new FakeTm();
    const fetchFn = keyServer();
    writeNetworkJson({});
    await expect(ensureEnrolled(opts(tm, { fetch: fetchFn as unknown as typeof fetch }))).resolves.toBe('enrolled');

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(`${LICENSE}/v1/network/preauth-key`);
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer clerk.jwt.token');

    expect(tm.calls).toEqual(['up']);
    const up = tm.upArgs[0]!;
    expect(up.content).toBe(KEY);
    expect(up.hostname).toBe('airbridge-janes-macbook-pro');
    expect(up.loginServer).toBe(LOGIN);
    expect(up.file.startsWith(join(dir, '.authkey-'))).toBe(true);
    if (process.platform !== 'win32') expect(up.mode).toBe(0o600);
    // The key travels by file path only — never as an argument value.
    expect([up.file, up.hostname, up.loginServer].join(' ')).not.toContain(KEY);

    expect(keyFiles()).toEqual([]);
    expect(readNetworkJson()).toMatchObject({ v: 1, socket: '/s', login_server: LOGIN, enrolled_sub_hash: subHash(SUB) });
    expect(logs.join('\n')).not.toContain(KEY);
  });

  it('restart with matching enrollment: no new key, no up, no logout', async () => {
    const tm = new FakeTm();
    tm.state = { state: 'connected', ip: '100.64.0.2' };
    writeNetworkJson({ login_server: LOGIN, enrolled_sub_hash: subHash(SUB) });
    const fetchFn = keyServer();
    await expect(ensureEnrolled(opts(tm, { fetch: fetchFn as unknown as typeof fetch }))).resolves.toBe('already_enrolled');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(tm.calls).toEqual([]);
  });

  it('a different Clerk user (sub hash differs): logout first, then re-enroll', async () => {
    const tm = new FakeTm();
    tm.state = { state: 'connected' };
    writeNetworkJson({ login_server: LOGIN, enrolled_sub_hash: subHash(OTHER) });
    await expect(ensureEnrolled(opts(tm))).resolves.toBe('enrolled');
    expect(tm.calls).toEqual(['logout', 'up']);
    expect(readNetworkJson().enrolled_sub_hash).toBe(subHash(SUB));
  });

  it('a different login server (expectedLoginServer mismatch): logout first, then re-enroll', async () => {
    const tm = new FakeTm();
    tm.state = { state: 'connecting' };
    writeNetworkJson({ login_server: 'https://old-hs.example', enrolled_sub_hash: subHash(SUB) });
    await expect(ensureEnrolled(opts(tm, { expectedLoginServer: `${LOGIN}/` }))).resolves.toBe('enrolled');
    expect(tm.calls).toEqual(['logout', 'up']);
    expect(readNetworkJson().login_server).toBe(LOGIN);
  });

  it('logged in but network.json has no enrollment record: logout and re-enroll (owner unknown)', async () => {
    const tm = new FakeTm();
    tm.state = { state: 'connected' };
    await expect(ensureEnrolled(opts(tm))).resolves.toBe('enrolled');
    expect(tm.calls).toEqual(['logout', 'up']);
  });

  it('key file is deleted even when tailscale up fails; error carries no key', async () => {
    const tm = new FakeTm();
    tm.failUp = true;
    const err = await ensureEnrolled(opts(tm)).catch((e) => e);
    expect(err).toBeInstanceOf(EnrollError);
    expect(err.code).toBe('up_failed');
    expect(String(err.message)).not.toContain(KEY);
    expect(tm.upArgs[0]!.content).toBe(KEY); // it did exist during up
    expect(keyFiles()).toEqual([]);
    expect(logs.join('\n')).not.toContain(KEY);
  });

  it('stale key files from a crash are swept before writing a new one', async () => {
    writeFileSync(join(dir, '.authkey-deadbeef'), 'old-secret', { mode: 0o600 });
    const tm = new FakeTm();
    await ensureEnrolled(opts(tm));
    expect(keyFiles()).toEqual([]);
  });

  it.each([
    [401, 'unauthorized'],
    [402, 'not_entitled'],
    [429, 'rate_limited'],
    [503, 'network_unavailable'],
    [500, 'server_error'],
  ])('license server %i -> EnrollError(%s), no up, no key file', async (status, code) => {
    const tm = new FakeTm();
    const err = await ensureEnrolled(opts(tm, { fetch: keyServer(status, { error: 'x' }) as unknown as typeof fetch })).catch((e) => e);
    expect(err).toMatchObject({ code });
    expect(tm.calls).toEqual([]);
    expect(keyFiles()).toEqual([]);
  });

  it('rejects malformed responses (bad key shape, http login server) without calling up', async () => {
    for (const body of [
      { auth_key: 'short', login_server: LOGIN },
      { auth_key: `${KEY} --exit-node=x`, login_server: LOGIN },
      { auth_key: KEY, login_server: 'http://evil.example' },
      { auth_key: KEY },
    ]) {
      const tm = new FakeTm();
      await expect(ensureEnrolled(opts(tm, { fetch: keyServer(200, body) as unknown as typeof fetch }))).rejects.toMatchObject({ code: 'bad_response' });
      expect(tm.calls).toEqual([]);
    }
  });

  it('network errors -> unreachable', async () => {
    const tm = new FakeTm();
    const fetchFn = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(ensureEnrolled(opts(tm, { fetch: fetchFn as unknown as typeof fetch }))).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('signed out -> no-op', async () => {
    const tm = new FakeTm();
    const fetchFn = keyServer();
    await expect(ensureEnrolled(opts(tm, { getUserSub: () => null, fetch: fetchFn as unknown as typeof fetch }))).resolves.toBe('signed_out');
    await expect(ensureEnrolled(opts(tm, { getAuthToken: async () => null, fetch: fetchFn as unknown as typeof fetch }))).resolves.toBe('signed_out');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(tm.calls).toEqual([]);
  });

  it('waits for tailscaled to leave starting; times out with daemon_not_ready', async () => {
    const tm = new FakeTm();
    tm.state = { state: 'starting' };
    setTimeout(() => (tm.state = { state: 'needs_login' }), 20);
    await expect(ensureEnrolled(opts(tm))).resolves.toBe('enrolled');

    const stuck = new FakeTm();
    stuck.state = { state: 'stopped' };
    await expect(ensureEnrolled(opts(stuck, { readyTimeoutMs: 30 }))).rejects.toMatchObject({ code: 'daemon_not_ready' });
  });

  it('uses tm.recordEnrollment when TailscaleManager provides it', async () => {
    const tm = new FakeTm() as FakeTm & { recordEnrollment: ReturnType<typeof vi.fn> };
    tm.recordEnrollment = vi.fn();
    await ensureEnrolled(opts(tm));
    expect(tm.recordEnrollment).toHaveBeenCalledWith({ loginServer: LOGIN, subHash: subHash(SUB) });
  });

  it('windows: restricts the key file ACL via icacls (execFile, no shell) before tailscale reads it; failure is non-fatal', async () => {
    const tm = new FakeTm();
    const execFile = vi.fn(async (_f: string, _a: readonly string[]) => undefined);
    await ensureEnrolled(opts(tm, { platform: 'win32', execFile }));
    expect(execFile).toHaveBeenCalledTimes(1);
    const [file, args] = execFile.mock.calls[0]!;
    expect(file).toBe('icacls');
    expect(args[0]).toBe(tm.upArgs[0]!.file);
    expect(args.slice(1, 3)).toEqual(['/inheritance:r', '/grant:r']);
    expect(args.join(' ')).not.toContain(KEY);

    const tm2 = new FakeTm();
    const failing = vi.fn(async () => {
      throw new Error('icacls missing');
    });
    await expect(ensureEnrolled(opts(tm2, { platform: 'win32', execFile: failing }))).resolves.toBe('enrolled');
    expect(keyFiles()).toEqual([]);
  });
});
