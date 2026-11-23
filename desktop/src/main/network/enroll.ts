/**
 * Private-network enrollment (PHASE3_PLAN.md §2 "Enrollment").
 *
 *   status check (tm.status() + <D>/network.json)
 *     -> already enrolled for this Clerk user on this login server: nothing to do (no new key)
 *     -> otherwise: [logout if enrolled for someone/somewhere else]
 *        POST <license>/v1/network/preauth-key (Clerk bearer)
 *        write key to <D>/.authkey-<rand> (0600; Windows: user-only ACL via icacls, best-effort)
 *        tm.up(<file>, airbridge-<host>, login_server)   (TailscaleManager passes --auth-key=file:<file>)
 *        unlink the key file in `finally`, record {login_server, enrolled_sub_hash}
 *
 * The pre-auth key is NEVER logged, never put in argv, never returned, never kept in memory longer than
 * the write. Error messages carry fixed codes only.
 */
import { execFile as nodeExecFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { hostname as osHostname, userInfo } from 'node:os';
import { join } from 'node:path';
import type { NetStatus } from '../../shared/types';

/** The slice of Systems' TailscaleManager (src/main/network/TailscaleManager.ts) that enrollment needs. */
export interface TailscaleManagerLike {
  status(): Promise<NetStatus>;
  /** Runs `tailscale --socket=S up --reset --login-server=L --auth-key=file:<authKeyFile> --hostname=H ...`. */
  up(authKeyFile: string, hostname: string, loginServer: string): Promise<void>;
  logout(): Promise<void>;
  /**
   * Optional: persist `login_server` + `enrolled_sub_hash` into network.json (TailscaleManager owns that
   * file). When absent, enroll merges the two fields into network.json itself (atomic, 0600).
   */
  recordEnrollment?(info: { loginServer: string; subHash: string }): Promise<void> | void;
}

export type ExecFileFn = (file: string, args: readonly string[], opts: { windowsHide: boolean; timeout: number }) => Promise<void>;

export interface EnsureEnrolledOptions {
  tm: TailscaleManagerLike;
  /** Clerk bearer for the license server (OidcClient.getApiToken), null when signed out. */
  getAuthToken: () => Promise<string | null>;
  /** Signed-in Clerk user id (OidcClient.getUserId), null when signed out. */
  getUserSub: () => string | null;
  /** AIRBRIDGE_LICENSE_URL (https; http only for localhost). */
  licenseUrl: string;
  /** Shared data dir D (dataDir.ts). */
  dataDir: string;
  /** Defaults to os.hostname(); sanitized to `airbridge-<[a-z0-9-] ≤50>`. */
  deviceName?: string;
  fetch?: typeof fetch;
  /** Optional expected login server (e.g. from build config); a mismatch with network.json forces re-enrollment. */
  expectedLoginServer?: string;
  log?: (msg: string) => void;
  platform?: NodeJS.Platform;
  execFile?: ExecFileFn;
  /** How long to wait for tailscaled to leave `stopped`/`starting` (default 30 s). */
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
}

export type EnrollOutcome = 'already_enrolled' | 'enrolled' | 'signed_out';

export type EnrollErrorCode =
  | 'daemon_not_ready'
  | 'unauthorized'
  | 'not_entitled'
  | 'rate_limited'
  | 'network_unavailable'
  | 'server_error'
  | 'unreachable'
  | 'bad_response'
  | 'key_file_failed'
  | 'up_failed';

export class EnrollError extends Error {
  constructor(public readonly code: EnrollErrorCode) {
    super(`enroll_failed: ${code}`);
    this.name = 'EnrollError';
  }
}

export const NETWORK_JSON = 'network.json';
export const AUTHKEY_PREFIX = '.authkey-';
const AUTH_KEY_RE = /^[A-Za-z0-9_-]{16,512}$/;
const HOST_PREFIX = 'airbridge-';
const MAX_HOST_LABEL = 50;

/** sha256(clerk sub) hex — the `enrolled_sub_hash` stored in network.json. */
export function subHash(sub: string): string {
  return createHash('sha256').update(sub, 'utf8').digest('hex');
}

/** `airbridge-<[a-z0-9-] ≤50>` from a machine name ("Jane's MacBook-Pro.local" -> "airbridge-janes-macbook-pro"). */
export function sanitizeHostname(raw: string | null | undefined): string {
  const first = String(raw ?? '').split('.')[0] ?? '';
  let label = first
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (label.startsWith(HOST_PREFIX)) label = label.slice(HOST_PREFIX.length);
  label = label.slice(0, MAX_HOST_LABEL).replace(/-+$/g, '');
  return `${HOST_PREFIX}${label || 'device'}`;
}

/** https URL (http only for localhost), no credentials/query/fragment, canonical form without trailing slash. */
export function normalizeServerUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  if (u.username || u.password || u.search || u.hash) return null;
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

interface NetworkJson {
  login_server?: unknown;
  enrolled_sub_hash?: unknown;
  [k: string]: unknown;
}

async function readNetworkJson(dataDir: string): Promise<NetworkJson | null> {
  try {
    const v = JSON.parse(await fsp.readFile(join(dataDir, NETWORK_JSON), 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as NetworkJson) : null;
  } catch {
    return null;
  }
}

async function mergeNetworkJson(dataDir: string, patch: Record<string, unknown>): Promise<void> {
  const path = join(dataDir, NETWORK_JSON);
  const current = (await readNetworkJson(dataDir)) ?? { v: 1 };
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify({ ...current, ...patch }), { mode: 0o600, flag: 'wx' });
    await fsp.rename(tmp, path);
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
  }
}

const defaultExecFile: ExecFileFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    nodeExecFile(file, [...args], opts, (err) => (err ? reject(err) : resolve()));
  });

/** Remove key files left behind by a crash mid-enrollment. */
async function sweepStaleKeyFiles(dataDir: string): Promise<void> {
  let names: string[];
  try {
    names = await fsp.readdir(dataDir);
  } catch {
    return;
  }
  await Promise.all(
    names.filter((n) => n.startsWith(AUTHKEY_PREFIX)).map((n) => fsp.rm(join(dataDir, n), { force: true }).catch(() => undefined)),
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitReady(tm: TailscaleManagerLike, timeoutMs: number, pollMs: number): Promise<NetStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await tm.status().catch((): NetStatus => ({ state: 'error' }));
    if (st.state !== 'stopped' && st.state !== 'starting' && st.state !== 'error') return st;
    if (Date.now() >= deadline) throw new EnrollError('daemon_not_ready');
    await sleep(pollMs);
  }
}

/** Ask the license server for a single-use pre-auth key. The returned key must only be written to the key file. */
async function fetchPreauthKey(o: EnsureEnrolledOptions, bearer: string): Promise<{ authKey: string; loginServer: string }> {
  const base = normalizeServerUrl(o.licenseUrl);
  if (!base) throw new EnrollError('bad_response');
  const fetchFn = o.fetch ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(`${base}/v1/network/preauth-key`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(o.requestTimeoutMs ?? 20_000),
    });
  } catch {
    throw new EnrollError('unreachable');
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 401) throw new EnrollError('unauthorized');
    if (res.status === 402) throw new EnrollError('not_entitled');
    if (res.status === 429) throw new EnrollError('rate_limited');
    if (res.status === 503) throw new EnrollError('network_unavailable');
    throw new EnrollError('server_error');
  }
  let body: { auth_key?: unknown; login_server?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new EnrollError('bad_response');
  }
  const loginServer = normalizeServerUrl(body?.login_server);
  if (typeof body?.auth_key !== 'string' || !AUTH_KEY_RE.test(body.auth_key) || !loginServer) throw new EnrollError('bad_response');
  return { authKey: body.auth_key, loginServer };
}

/** Create the key file 0600 (Windows: strip inherited ACEs, grant only the current user) and write the key. */
async function writeKeyFile(o: EnsureEnrolledOptions, path: string, key: string): Promise<void> {
  // 'wx': never follow/overwrite an existing path. Created empty first so the ACL is fixed before the secret lands.
  const fh = await fsp.open(path, 'wx', 0o600);
  try {
    if ((o.platform ?? process.platform) === 'win32') {
      try {
        const user = userInfo().username;
        await (o.execFile ?? defaultExecFile)('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`], { windowsHide: true, timeout: 10_000 });
      } catch {
        o.log?.('enroll: could not restrict key file ACL (continuing; file lives in the per-user data dir)');
      }
    }
    await fh.writeFile(key, 'utf8');
    await fh.sync().catch(() => undefined);
  } finally {
    await fh.close();
  }
}

/**
 * Make sure this device is enrolled in the signed-in customer's private network.
 * Call after `tm.start()` and before `pm.start()`; safe to call on every launch (no key is fetched when
 * the existing enrollment matches). Throws EnrollError on failure; returns 'signed_out' when there is no user.
 */
export async function ensureEnrolled(o: EnsureEnrolledOptions): Promise<EnrollOutcome> {
  const log = o.log ?? (() => undefined);
  const sub = o.getUserSub();
  if (!sub) return 'signed_out';
  const wantHash = subHash(sub);

  const st = await waitReady(o.tm, o.readyTimeoutMs ?? 30_000, o.pollIntervalMs ?? 500);
  const recorded = await readNetworkJson(o.dataDir);
  const recordedServer = normalizeServerUrl(recorded?.login_server);
  const expected = o.expectedLoginServer ? normalizeServerUrl(o.expectedLoginServer) : null;
  const sameUser = recorded?.enrolled_sub_hash === wantHash;
  const sameServer = !!recordedServer && (!expected || expected === recordedServer);
  const loggedIn = st.state !== 'needs_login';

  if (loggedIn && sameUser && sameServer) return 'already_enrolled';

  let loggedOut = false;
  const logoutOnce = async () => {
    if (loggedOut || !loggedIn) return;
    loggedOut = true;
    log('enroll: existing enrollment belongs to another account or server; logging out');
    await o.tm.logout();
  };
  if (loggedIn) await logoutOnce();

  const bearer = await o.getAuthToken();
  if (!bearer) return 'signed_out';
  const { authKey, loginServer } = await fetchPreauthKey(o, bearer);

  await sweepStaleKeyFiles(o.dataDir);
  const keyPath = join(o.dataDir, `${AUTHKEY_PREFIX}${randomBytes(16).toString('hex')}`);
  const hostname = sanitizeHostname(o.deviceName ?? osHostname());
  try {
    try {
      await writeKeyFile(o, keyPath, authKey);
    } catch {
      throw new EnrollError('key_file_failed');
    }
    log(`enroll: joining private network as ${hostname}`);
    try {
      await o.tm.up(keyPath, hostname, loginServer);
    } catch {
      throw new EnrollError('up_failed');
    }
  } finally {
    await fsp.rm(keyPath, { force: true }).catch(() => undefined);
  }

  const info = { loginServer, subHash: wantHash };
  try {
    if (o.tm.recordEnrollment) await o.tm.recordEnrollment(info);
    else await mergeNetworkJson(o.dataDir, { login_server: loginServer, enrolled_sub_hash: wantHash });
  } catch {
    log('enroll: enrolled, but could not record enrollment in network.json');
  }
  log('enroll: enrolled');
  return 'enrolled';
}
