/**
 * Private-network enrollment for the airbridge-net sidecar (PHASE3_PLAN.md §9).
 *
 *   recorded enrollment (network.json: login_server + sha256(clerk sub)) matches this user/server
 *   AND node state exists -> spawn the sidecar WITHOUT a key -> it reports connected/connecting:
 *      done (restart reuses state, no new key)
 *   otherwise (or the sidecar says needs_login):
 *      [state belongs to another account/server: logout + wipe <D>/tsnet]
 *      POST <license>/v1/network/preauth-key (Clerk bearer)
 *      respawn the sidecar with {auth_key} on its stdin -> wait for connected -> record enrollment
 *
 * The pre-auth key is NEVER logged, never put in argv/env, never written to a file, never returned:
 * it lives only until NetManager writes it to the child's stdin. Error messages carry fixed codes only.
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import type { NetStatus } from '../../shared/types';
import type { SidecarLaunch } from './NetManager';

/** The slice of NetManager (src/main/network/NetManager.ts) that enrollment needs. */
export interface NetManagerLike {
  /** (Re)spawn the sidecar; an authKey is written to its stdin and then forgotten. */
  start(launch: SidecarLaunch): Promise<void>;
  status(): Promise<NetStatus>;
  /** POST /logout on the running sidecar (best effort) and clear the enrollment record. */
  logout(): Promise<void>;
  /** Stop the sidecar and delete <D>/tsnet. */
  wipeState(): Promise<void>;
  /** Node state exists on disk. */
  hasState(): boolean;
  isRunning(): boolean;
  enrollment(): { loginServer: string | null; subHash: string | null };
  recordEnrollment(info: { loginServer: string; subHash: string }): Promise<void> | void;
}

export interface EnsureEnrolledOptions {
  nm: NetManagerLike;
  /** Clerk bearer for the license server (OidcClient.getApiToken), null when signed out. */
  getAuthToken: () => Promise<string | null>;
  /** Signed-in Clerk user id (OidcClient.getUserId), null when signed out. */
  getUserSub: () => string | null;
  /** AIRBRIDGE_LICENSE_URL (https; http only for localhost). */
  licenseUrl: string;
  /** Shared data dir D (dataDir.ts): legacy key-file sweep only. */
  dataDir: string;
  /** Defaults to os.hostname(); sanitized to `airbridge-<[a-z0-9-] ≤50>`. */
  deviceName?: string;
  fetch?: typeof fetch;
  /** Optional expected login server (e.g. from build config); a mismatch with network.json forces re-enrollment. */
  expectedLoginServer?: string;
  log?: (msg: string) => void;
  /** How long to wait for a key-less sidecar to say whether it still has a valid node (default 15 s). */
  settleTimeoutMs?: number;
  /** How long to wait for `connected` after joining with a key (default 60 s). */
  joinTimeoutMs?: number;
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
  | 'up_failed';

export class EnrollError extends Error {
  constructor(public readonly code: EnrollErrorCode) {
    super(`enroll_failed: ${code}`);
    this.name = 'EnrollError';
  }
}

/** Legacy (bundled-tailscaled) key drops: swept on enrollment, never created any more. */
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

/** Poll nm.status() until `done(state)` or the timeout; returns the last status. */
async function waitFor(nm: NetManagerLike, done: (s: NetStatus) => boolean, timeoutMs: number, pollMs: number): Promise<NetStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await nm.status().catch((): NetStatus => ({ state: 'error' }));
    if (done(st) || Date.now() >= deadline) return st;
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

/**
 * Make sure this device is on the signed-in customer's private network (spawns the sidecar).
 * Safe to call on every launch: no key is fetched while the recorded enrollment matches and the sidecar
 * does not report needs_login. Throws EnrollError on failure; returns 'signed_out' when there is no user.
 */
export async function ensureEnrolled(o: EnsureEnrolledOptions): Promise<EnrollOutcome> {
  const log = o.log ?? (() => undefined);
  const sub = o.getUserSub();
  if (!sub) return 'signed_out';
  const wantHash = subHash(sub);
  const hostname = sanitizeHostname(o.deviceName ?? osHostname());
  const poll = o.pollIntervalMs ?? 500;

  const rec = o.nm.enrollment();
  const recordedServer = normalizeServerUrl(rec.loginServer);
  const expected = o.expectedLoginServer ? normalizeServerUrl(o.expectedLoginServer) : null;
  const sameUser = rec.subHash === wantHash;
  const sameServer = !!recordedServer && (!expected || expected === recordedServer);

  if (sameUser && sameServer && o.nm.hasState()) {
    await o.nm.start({ controlUrl: recordedServer!, hostname });
    const st = await waitFor(
      o.nm,
      (s) => s.state === 'connected' || s.state === 'needs_login' || s.state === 'error' || s.state === 'stopped',
      o.settleTimeoutMs ?? 15_000,
      poll,
    );
    if (st.state === 'error' || st.state === 'stopped') throw new EnrollError('daemon_not_ready');
    // connected, or still connecting (offline / control server down): the node is enrolled.
    if (st.state !== 'needs_login') return 'already_enrolled';
    log('enroll: this device needs to join the private network again');
  } else if (o.nm.hasState() || rec.subHash) {
    log('enroll: existing network state belongs to another account or server; resetting it');
    if (o.nm.isRunning()) await o.nm.logout().catch(() => undefined);
    await o.nm.wipeState();
  }

  const bearer = await o.getAuthToken();
  if (!bearer) return 'signed_out';
  let key: { authKey: string; loginServer: string } | null = await fetchPreauthKey(o, bearer);
  await sweepStaleKeyFiles(o.dataDir);
  const loginServer = key.loginServer;
  log(`enroll: joining private network as ${hostname}`);
  try {
    await o.nm.start({ controlUrl: loginServer, hostname, authKey: key.authKey });
  } catch {
    throw new EnrollError('up_failed');
  } finally {
    key = null; // drop our reference: NetManager already wrote it to the sidecar's stdin
  }
  const st = await waitFor(o.nm, (s) => s.state === 'connected' || s.state === 'error' || s.state === 'stopped', o.joinTimeoutMs ?? 60_000, poll);
  if (st.state !== 'connected') throw new EnrollError('up_failed');

  try {
    await o.nm.recordEnrollment({ loginServer, subHash: wantHash });
  } catch {
    log('enroll: enrolled, but could not record enrollment in network.json');
  }
  log('enroll: enrolled');
  return 'enrolled';
}
