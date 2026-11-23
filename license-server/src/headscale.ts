/**
 * Typed client for the Headscale v0.29.7 REST API (grpc-gateway in front of HeadscaleService).
 *
 * Verified against the v0.29.7 source (proto/headscale/v1/*.proto, hscontrol/grpcv1.go, hscontrol/app.go):
 *  - Every route lives under `/api/v1/*` behind `Authorization: Bearer <api key>`.
 *  - JSON is grpc-gateway's default protojson: lowerCamelCase field names in responses
 *    (`preAuthKey`, `givenName`, `ipAddresses`), uint64 ids encoded as JSON *strings*, timestamps RFC 3339.
 *    Requests accept either proto or camel names; uint64 may be sent as a string.
 *  - GET    /api/v1/user?name=<n>              -> { users: User[] }            (exact-name filter)
 *  - POST   /api/v1/user {name}                -> { user: User }               (duplicate name -> HTTP 500, NOT 409)
 *  - POST   /api/v1/preauthkey {user: <uint64 id>, reusable, ephemeral, expiration}
 *                                              -> { preAuthKey: { key, id, expiration, ... } } (full key only on create)
 *  - GET    /api/v1/node/{node_id}             -> { node: Node }               (unknown id -> 404)
 *  - DELETE /api/v1/node/{node_id}             -> {}
 *  - GET    /api/v1/node?user=<name>           -> { nodes: Node[] }            (unknown user -> 500, so look the user up first)
 *  - GET    /api/v1/policy                     -> { policy: string, updatedAt }  (file mode: the policy file's raw HuJSON)
 *
 * Upstream response bodies are never surfaced: errors carry only method, route template and status.
 */

export interface HeadscaleUser {
  id: string;
  name: string;
}

export interface HeadscaleNode {
  id: string;
  name: string;
  user: HeadscaleUser | null;
}

export interface HeadscalePreAuthKey {
  key: string;
  expiration: string | null;
}

export type HeadscaleErrorKind = 'timeout' | 'network' | 'http' | 'bad_response';

export class HeadscaleError extends Error {
  constructor(
    public readonly kind: HeadscaleErrorKind,
    public readonly route: string,
    public readonly status: number | null = null,
  ) {
    super(`headscale ${route} failed: ${kind}${status !== null ? ` ${status}` : ''}`);
    this.name = 'HeadscaleError';
  }
}

export interface HeadscaleApi {
  findUserByName(name: string): Promise<HeadscaleUser | null>;
  createUser(name: string): Promise<HeadscaleUser>;
  /** GET, then POST; if POST fails (e.g. a concurrent create -> 500 unique violation) re-GET once. */
  ensureUser(name: string): Promise<HeadscaleUser>;
  createPreAuthKey(p: { userId: string; reusable: boolean; ephemeral: boolean; expiration: Date }): Promise<HeadscalePreAuthKey>;
  /** null when Headscale answers 404. */
  getNode(id: string): Promise<HeadscaleNode | null>;
  deleteNode(id: string): Promise<void>;
  listNodesByUser(userName: string): Promise<HeadscaleNode[]>;
  /** Raw policy document (HuJSON) as Headscale reports it. */
  getPolicy(): Promise<string>;
  /** Every user (used only by the temporary smoke-test cleanup). */
  listUsers(): Promise<HeadscaleUser[]>;
  /** Delete a user (its nodes must be deleted first). Used only by the temporary smoke-test cleanup. */
  deleteUser(id: string): Promise<void>;
}

export interface HeadscaleClientOptions {
  /** Base URL of the Headscale server (HEADSCALE_URL), e.g. https://hs.example.com */
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const UINT64 = /^[0-9]{1,20}$/;
const AUTH_KEY = /^[A-Za-z0-9_-]{16,512}$/;

function asId(v: unknown): string | null {
  if (typeof v === 'string' && UINT64.test(v)) return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  return null;
}

function parseUser(v: unknown): HeadscaleUser | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const id = asId(o.id);
  if (!id || typeof o.name !== 'string') return null;
  return { id, name: o.name };
}

function parseNode(v: unknown): HeadscaleNode | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const id = asId(o.id);
  if (!id) return null;
  return {
    id,
    name: typeof o.givenName === 'string' ? o.givenName : typeof o.name === 'string' ? o.name : '',
    user: parseUser(o.user),
  };
}

export function createHeadscaleClient(opts: HeadscaleClientOptions): HeadscaleApi {
  const u = new URL(opts.baseUrl);
  const base = u.origin + u.pathname.replace(/\/+$/, '');
  const fetchFn = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;

  /** `route` is a fixed template for logs/errors; `path` is the concrete (already-encoded) path. */
  async function call(method: string, route: string, path: string, body?: unknown, allow404 = false): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchFn(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'error', // never replay the bearer key to another origin
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      throw new HeadscaleError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network', `${method} ${route}`);
    }
    if (allow404 && res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    if (res.status < 200 || res.status >= 300) {
      await res.body?.cancel().catch(() => undefined);
      throw new HeadscaleError('http', `${method} ${route}`, res.status);
    }
    try {
      return await res.json();
    } catch {
      throw new HeadscaleError('bad_response', `${method} ${route}`, res.status);
    }
  }

  const bad = (route: string): never => {
    throw new HeadscaleError('bad_response', route);
  };

  const api: HeadscaleApi = {
    async findUserByName(name) {
      const r = (await call('GET', '/api/v1/user?name=', `/api/v1/user?name=${encodeURIComponent(name)}`)) as {
        users?: unknown;
      } | null;
      const users = Array.isArray(r?.users) ? r!.users : [];
      for (const raw of users) {
        const user = parseUser(raw);
        if (user && user.name === name) return user;
      }
      return null;
    },

    async createUser(name) {
      const r = (await call('POST', '/api/v1/user', '/api/v1/user', { name })) as { user?: unknown } | null;
      return parseUser(r?.user) ?? bad('POST /api/v1/user');
    },

    async ensureUser(name) {
      const existing = await api.findUserByName(name);
      if (existing) return existing;
      try {
        return await api.createUser(name);
      } catch (e) {
        if (!(e instanceof HeadscaleError) || e.kind !== 'http') throw e;
        // Lost a race with a concurrent create (Headscale maps the unique violation to 500).
        const again = await api.findUserByName(name);
        if (again) return again;
        throw e;
      }
    },

    async createPreAuthKey(p) {
      if (!UINT64.test(p.userId)) throw new HeadscaleError('bad_response', 'POST /api/v1/preauthkey');
      const r = (await call('POST', '/api/v1/preauthkey', '/api/v1/preauthkey', {
        user: p.userId,
        reusable: p.reusable,
        ephemeral: p.ephemeral,
        expiration: p.expiration.toISOString(),
      })) as { preAuthKey?: { key?: unknown; expiration?: unknown } } | null;
      const key = r?.preAuthKey?.key;
      if (typeof key !== 'string' || !AUTH_KEY.test(key)) return bad('POST /api/v1/preauthkey');
      const exp = r?.preAuthKey?.expiration;
      return { key, expiration: typeof exp === 'string' ? exp : null };
    },

    async getNode(id) {
      if (!UINT64.test(id)) return null;
      const r = (await call('GET', '/api/v1/node/{id}', `/api/v1/node/${id}`, undefined, true)) as { node?: unknown } | null;
      if (r === null) return null;
      return parseNode(r.node) ?? bad('GET /api/v1/node/{id}');
    },

    async deleteNode(id) {
      if (!UINT64.test(id)) throw new HeadscaleError('bad_response', 'DELETE /api/v1/node/{id}');
      await call('DELETE', '/api/v1/node/{id}', `/api/v1/node/${id}`);
    },

    async listNodesByUser(userName) {
      const r = (await call('GET', '/api/v1/node?user=', `/api/v1/node?user=${encodeURIComponent(userName)}`)) as {
        nodes?: unknown;
      } | null;
      const nodes = Array.isArray(r?.nodes) ? r!.nodes : [];
      return nodes.map(parseNode).filter((n): n is HeadscaleNode => n !== null);
    },

    async getPolicy() {
      const r = (await call('GET', '/api/v1/policy', '/api/v1/policy')) as { policy?: unknown } | null;
      return typeof r?.policy === 'string' ? r.policy : bad('GET /api/v1/policy');
    },

    async listUsers() {
      const r = (await call('GET', '/api/v1/user', '/api/v1/user')) as { users?: unknown } | null;
      const users = Array.isArray(r?.users) ? r!.users : [];
      return users.map(parseUser).filter((u): u is HeadscaleUser => u !== null);
    },

    async deleteUser(id) {
      if (!UINT64.test(id)) throw new HeadscaleError('bad_response', 'DELETE /api/v1/user/{id}');
      await call('DELETE', '/api/v1/user/{id}', `/api/v1/user/${id}`);
    },
  };
  return api;
}
