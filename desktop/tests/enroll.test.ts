import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  type NetManagerLike,
} from '../src/main/network/enroll';
import type { SidecarLaunch } from '../src/main/network/NetManager';
import type { NetStatus } from '../src/shared/types';

const SUB = 'user_2abcDEF123';
const OTHER = 'user_9zzzOTHER77';
const LICENSE = 'https://license.test.example';
const LOGIN = 'https://hs.test.example';
// Built at runtime so secret scanners never see a key-shaped literal.
const KEY = ['hskey', 'auth', 'abcdefghijkl', 'offlinetestsecret0000'].join('-');

/** In-memory sidecar: a valid key (or existing state) -> connected; no state -> needs_login. */
class FakeNm implements NetManagerLike {
  state = false; // node state on disk
  nodeValid = true; // false: the control server forgot this node (needs_login even with state)
  running = false;
  acceptKey = true;
  calls: string[] = [];
  launches: SidecarLaunch[] = [];
  record: { loginServer: string | null; subHash: string | null } = { loginServer: null, subHash: null };

  async start(l: SidecarLaunch) {
    this.calls.push(l.authKey ? 'start+key' : 'start');
    this.launches.push({ ...l });
    this.running = true;
    if (l.authKey && this.acceptKey) {
      this.state = true;
      this.nodeValid = true;
    }
  }
  async stop() {
    this.calls.push('stop');
    this.running = false;
  }
  async status(): Promise<NetStatus> {
    if (!this.running) return { state: 'stopped' };
    return this.state && this.nodeValid ? { state: 'connected', ip: '100.64.0.2' } : { state: 'needs_login' };
  }
  async logout() {
    this.calls.push('logout');
    this.record = { loginServer: null, subHash: null };
  }
  async wipeState() {
    this.calls.push('wipe');
    this.running = false;
    this.state = false;
  }
  hasState() {
    return this.state;
  }
  isRunning() {
    return this.running;
  }
  enrollment() {
    return { ...this.record };
  }
  recordEnrollment(info: { loginServer: string; subHash: string }) {
    this.calls.push('record');
    this.record = { ...info };
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

function opts(nm: FakeNm, over: Partial<EnsureEnrolledOptions> = {}): EnsureEnrolledOptions {
  return {
    nm,
    getAuthToken: async () => 'clerk.jwt.token',
    getUserSub: () => SUB,
    licenseUrl: LICENSE,
    dataDir: dir,
    deviceName: "Jane's MacBook-Pro.local",
    fetch: keyServer() as unknown as typeof fetch,
    log: (m) => void logs.push(m),
    settleTimeoutMs: 200,
    joinTimeoutMs: 200,
    pollIntervalMs: 5,
    ...over,
  };
}

function enrolledNm(sub = SUB, server = LOGIN): FakeNm {
  const nm = new FakeNm();
  nm.state = true;
  nm.record = { loginServer: server, subHash: subHash(sub) };
  return nm;
}

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
  it('fresh device: fetches a key, spawns the sidecar with it (stdin), waits for connected, records enrollment', async () => {
    const nm = new FakeNm();
    const fetchFn = keyServer();
    const out = await ensureEnrolled(opts(nm, { fetch: fetchFn as unknown as typeof fetch }));
    expect(out).toBe('enrolled');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe(`${LICENSE}/v1/network/preauth-key`);
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer clerk.jwt.token');
    expect(init!.redirect).toBe('error');
    expect(nm.launches).toEqual([{ controlUrl: LOGIN, hostname: 'airbridge-janes-macbook-pro', authKey: KEY }]);
    expect(nm.record).toEqual({ loginServer: LOGIN, subHash: subHash(SUB) });
    expect(logs.join('\n')).not.toContain(KEY);
    expect(readdirSync(dir).filter((n) => n.startsWith('.authkey-'))).toEqual([]); // no key files any more
  });

  it('restart with matching enrollment + state: key-less spawn, no new key, no logout', async () => {
    const nm = enrolledNm();
    const fetchFn = keyServer();
    expect(await ensureEnrolled(opts(nm, { fetch: fetchFn as unknown as typeof fetch }))).toBe('already_enrolled');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(nm.calls).toEqual(['start']);
    expect(nm.launches[0]).toEqual({ controlUrl: LOGIN, hostname: 'airbridge-janes-macbook-pro' });
  });

  it('matching record but the sidecar says needs_login (node removed on the server): fetch a key, respawn with it', async () => {
    const nm = enrolledNm();
    nm.nodeValid = false;
    expect(await ensureEnrolled(opts(nm))).toBe('enrolled');
    expect(nm.calls).toEqual(['start', 'start+key', 'record']);
  });

  it('still connecting after the settle timeout (offline): treated as enrolled, no key fetched', async () => {
    const nm = enrolledNm();
    nm.status = async () => ({ state: 'connecting' });
    const fetchFn = keyServer();
    expect(await ensureEnrolled(opts(nm, { fetch: fetchFn as unknown as typeof fetch }))).toBe('already_enrolled');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('a different Clerk user: logout + wipe the node state, then enroll fresh', async () => {
    const nm = enrolledNm(OTHER);
    nm.running = true;
    expect(await ensureEnrolled(opts(nm))).toBe('enrolled');
    expect(nm.calls).toEqual(['logout', 'wipe', 'start+key', 'record']);
    expect(nm.record.subHash).toBe(subHash(SUB));
  });

  it('a different login server (expectedLoginServer mismatch): wipe, then re-enroll', async () => {
    const nm = enrolledNm(SUB, 'https://old-hs.example');
    expect(await ensureEnrolled(opts(nm, { expectedLoginServer: LOGIN }))).toBe('enrolled');
    expect(nm.calls).toEqual(['wipe', 'start+key', 'record']);
  });

  it('state on disk but no enrollment record (owner unknown): wipe and re-enroll', async () => {
    const nm = new FakeNm();
    nm.state = true;
    expect(await ensureEnrolled(opts(nm))).toBe('enrolled');
    expect(nm.calls[0]).toBe('wipe');
  });

  it('key rejected by the control server: up_failed, nothing recorded, error carries no key', async () => {
    const nm = new FakeNm();
    nm.acceptKey = false;
    const err = await ensureEnrolled(opts(nm)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnrollError);
    expect((err as EnrollError).code).toBe('up_failed');
    expect(String((err as Error).message)).not.toContain(KEY);
    expect(nm.record.subHash).toBeNull();
  });

  it('legacy key files from the tailscaled era are swept', async () => {
    writeFileSync(join(dir, '.authkey-deadbeef'), 'old');
    await ensureEnrolled(opts(new FakeNm()));
    expect(readdirSync(dir).filter((n) => n.startsWith('.authkey-'))).toEqual([]);
  });

  it.each([
    [401, 'unauthorized'],
    [402, 'not_entitled'],
    [429, 'rate_limited'],
    [503, 'network_unavailable'],
    [500, 'server_error'],
  ])('license server %i -> %s, sidecar never given a key', async (status, code) => {
    const nm = new FakeNm();
    const err = await ensureEnrolled(opts(nm, { fetch: keyServer(status, {}) as unknown as typeof fetch })).catch((e: unknown) => e);
    expect((err as EnrollError).code).toBe(code);
    expect(nm.calls).not.toContain('start+key');
  });

  it('rejects malformed responses (bad key shape, http login server) without spawning', async () => {
    for (const body of [
      { auth_key: 'short', login_server: LOGIN },
      { auth_key: `${KEY} --evil`, login_server: LOGIN },
      { auth_key: KEY, login_server: 'http://hs.example.com' },
      { auth_key: KEY },
    ]) {
      const nm = new FakeNm();
      const err = await ensureEnrolled(opts(nm, { fetch: keyServer(200, body) as unknown as typeof fetch })).catch((e: unknown) => e);
      expect((err as EnrollError).code).toBe('bad_response');
      expect(nm.calls).toEqual([]);
    }
  });

  it('network errors -> unreachable', async () => {
    const nm = new FakeNm();
    const fetchFn = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const err = await ensureEnrolled(opts(nm, { fetch: fetchFn as unknown as typeof fetch })).catch((e: unknown) => e);
    expect((err as EnrollError).code).toBe('unreachable');
  });

  it('signed out -> no-op', async () => {
    const nm = new FakeNm();
    const fetchFn = keyServer();
    expect(await ensureEnrolled(opts(nm, { getUserSub: () => null, fetch: fetchFn as unknown as typeof fetch }))).toBe('signed_out');
    expect(await ensureEnrolled(opts(nm, { getAuthToken: async () => null, fetch: fetchFn as unknown as typeof fetch }))).toBe('signed_out');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(nm.calls).toEqual([]);
  });

  it('sidecar cannot start (component missing / error) on a key-less restart -> daemon_not_ready', async () => {
    const nm = enrolledNm();
    nm.status = async () => ({ state: 'error' });
    const err = await ensureEnrolled(opts(nm)).catch((e: unknown) => e);
    expect((err as EnrollError).code).toBe('daemon_not_ready');
  });
});
