/**
 * Desktop installers, published by CI and served by Caddy from the same directory.
 *
 *  POST /v1/releases/upload?name=<file>   GitHub OIDC (desktop-build.yml)   raw body, streamed to disk, ≤ maxBytes
 *  POST /v1/releases/publish  {version}   GitHub OIDC (desktop-build.yml)   writes latest.json for the run's commit
 *  POST /v1/releases/rollback {id}        Bearer WAITLIST_ADMIN_TOKEN       points latest.json at a kept release
 *  GET  /v1/downloads/count               Caddy forward_auth only (blocked at the edge): counts one download
 *  POST /v1/deploy                        GitHub OIDC (server-deploy.yml)   asks the host to deploy the run's commit
 *  GET  /v1/deploy/status                 public, non-secret: what the host last deployed
 *
 * Layout of the releases directory (Caddy serves it read-only at /downloads/):
 *   latest.json                 the manifest the landing page reads
 *   releases.json               published releases, newest first (at most KEEP_RELEASES; older ones are pruned)
 *   <version>-<sha7>/<name>     installers; a directory is never changed after it is published
 *   .incoming/                  partial uploads (hidden by Caddy)
 * Release ids embed the commit, so a URL always means the same bytes and can be cached forever.
 */
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Context, Hono } from 'hono';
import { OidcError, type GithubOidcPolicy, type GithubOidcVerifier } from './githubOidc.js';
import { bearerMatches } from './waitlist.js';
import { RateLimiter } from './rateLimit.js';

export const KEEP_RELEASES = 3;
export const DEFAULT_MAX_UPLOAD_BYTES = 400 * 1024 * 1024;
const VERSION = '\\d{1,4}\\.\\d{1,4}\\.\\d{1,4}(?:-[0-9A-Za-z]{1,20}(?:\\.[0-9A-Za-z]{1,20}){0,3})?';
const INSTALLER = new RegExp(`^AirBridge-Pro-(${VERSION})-(mac-arm64|mac-x64|win-x64)\\.(dmg|exe)$`);
const VERSION_RE = new RegExp(`^${VERSION}$`);
const RELEASE_ID = new RegExp(`^(${VERSION})-([0-9a-f]{7})$`);

export type Platform = 'mac' | 'win';
export interface Installer {
  version: string;
  platform: Platform;
  arch: 'arm64' | 'x64';
  kind: 'dmg' | 'exe';
}

/** Whitelisted installer names only: AirBridge-Pro-<semver>-<mac-arm64|mac-x64|win-x64>.<dmg|exe>. */
export function parseInstallerName(name: string): Installer | null {
  const m = INSTALLER.exec(name);
  if (!m) return null;
  const [platform, arch] = m[2]!.split('-') as [Platform, 'arm64' | 'x64'];
  const kind = m[3] as 'dmg' | 'exe';
  if ((platform === 'mac') !== (kind === 'dmg')) return null;
  return { version: m[1]!, platform, arch, kind };
}

export const releaseId = (version: string, sha: string) => `${version}-${sha.slice(0, 7)}`;

export interface ManifestFile {
  platform: Platform;
  arch: string;
  kind: string;
  name: string;
  size: number;
  sha256: string;
  url: string;
}
export interface Manifest {
  version: string;
  id: string;
  commit: string;
  published_at: string;
  files: ManifestFile[];
  previous: { id: string; version: string } | null;
}

class CapExceeded extends Error {}

async function writeAtomic(file: string, data: string, mode = 0o644): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}`);
  const fh = await fsp.open(tmp, 'w', mode);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.chmod(tmp, mode);
  await fsp.rename(tmp, file);
}

export class ReleaseStore {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private incoming() {
    return path.join(this.dir, '.incoming');
  }

  /** Create the layout and drop partial uploads left by a crash. */
  async init(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o755 });
    await fsp.rm(this.incoming(), { recursive: true, force: true });
    await fsp.mkdir(this.incoming(), { recursive: true, mode: 0o700 });
  }

  /** Serialize manifest changes (publish / rollback). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async releases(): Promise<Manifest[]> {
    try {
      const list = JSON.parse(await fsp.readFile(path.join(this.dir, 'releases.json'), 'utf8')) as unknown;
      return Array.isArray(list) ? (list as Manifest[]) : [];
    } catch {
      return [];
    }
  }

  async latest(): Promise<Manifest | null> {
    try {
      return JSON.parse(await fsp.readFile(path.join(this.dir, 'latest.json'), 'utf8')) as Manifest;
    } catch {
      return null;
    }
  }

  async isPublished(id: string): Promise<boolean> {
    return (await this.releases()).some((r) => r.id === id);
  }

  /** Stream `body` to <id>/<name>: temp file in .incoming, sha256 while writing, fsync, then rename. */
  async saveUpload(id: string, name: string, body: Readable, maxBytes: number): Promise<{ size: number; sha256: string }> {
    const tmp = path.join(this.incoming(), `${randomBytes(12).toString('hex')}.part`);
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) return cb(new CapExceeded('too large'));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o644 });
      await pipeline(body, meter, out);
      const fh = await fsp.open(tmp, 'r+');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
      if (size === 0) throw new Error('empty upload');
      const dest = path.join(this.dir, id);
      await fsp.mkdir(dest, { recursive: true, mode: 0o755 });
      await fsp.chmod(tmp, 0o644);
      await fsp.rename(tmp, path.join(dest, name));
      return { size, sha256: hash.digest('hex') };
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e;
    }
  }

  private async describe(id: string, name: string): Promise<ManifestFile | null> {
    const inst = parseInstallerName(name);
    if (!inst) return null;
    const file = path.join(this.dir, id, name);
    const st = await fsp.stat(file);
    const hash = createHash('sha256');
    await pipeline(fs.createReadStream(file), hash);
    return {
      platform: inst.platform,
      arch: inst.arch,
      kind: inst.kind,
      name,
      size: st.size,
      sha256: hash.digest('hex'),
      url: `/downloads/${id}/${name}`,
    };
  }

  /** Make release <version>-<sha7> the latest; keep the newest KEEP_RELEASES releases, delete the rest. */
  publish(version: string, commit: string): Promise<Manifest> {
    return this.exclusive(async () => {
      const id = releaseId(version, commit);
      let names: string[];
      try {
        names = (await fsp.readdir(path.join(this.dir, id))).filter((n) => parseInstallerName(n)?.version === version).sort();
      } catch {
        names = [];
      }
      if (names.length === 0) throw new PublishError('no_files');
      const files = (await Promise.all(names.map((n) => this.describe(id, n)))).filter((f): f is ManifestFile => !!f);
      const previousList = (await this.releases()).filter((r) => r.id !== id);
      const prev = previousList[0] ?? null;
      const manifest: Manifest = {
        version,
        id,
        commit,
        published_at: new Date(this.now()).toISOString(),
        files,
        previous: prev ? { id: prev.id, version: prev.version } : null,
      };
      const kept = [manifest, ...previousList].slice(0, KEEP_RELEASES);
      await writeAtomic(path.join(this.dir, 'releases.json'), JSON.stringify(kept, null, 2) + '\n');
      await writeAtomic(path.join(this.dir, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
      const keep = new Set(kept.map((r) => r.id));
      await this.prune(keep, new Set(previousList.map((r) => r.id).filter((x) => !keep.has(x))));
      return manifest;
    });
  }

  /** Point latest.json at a release that is still kept (newest-first order is unchanged). */
  rollback(id: string): Promise<Manifest> {
    return this.exclusive(async () => {
      const list = await this.releases();
      const target = list.find((r) => r.id === id);
      if (!target) throw new PublishError('unknown_release');
      const manifest: Manifest = { ...target, published_at: new Date(this.now()).toISOString() };
      await writeAtomic(path.join(this.dir, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
      return manifest;
    });
  }

  /**
   * Delete release directories that are not kept: those just dropped from releases.json at once, unpublished ones
   * (a failed run's uploads) after a day. A run that is still uploading is younger than that.
   */
  private async prune(keep: Set<string>, dropped: Set<string>): Promise<void> {
    const entries = await fsp.readdir(this.dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || !RELEASE_ID.test(e.name) || keep.has(e.name)) continue;
      const full = path.join(this.dir, e.name);
      const age = this.now() - (await fsp.stat(full)).mtimeMs;
      if (dropped.has(e.name) || age > 24 * 3600_000) await fsp.rm(full, { recursive: true, force: true });
    }
  }
}

export class PublishError extends Error {}

// ------------------------------------------------------------------------------------- download counts

export interface DownloadStats {
  total: number;
  by_platform: Record<string, number>;
  by_version: Record<string, Record<string, number>>;
  since: string | null;
}

/** Counts per version and platform-arch, kept in one small JSON file (written at most every 2 s). */
export class DownloadCounter {
  private counts: Record<string, Record<string, number>> = {};
  private since: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { counts?: Record<string, Record<string, number>>; since?: string };
      this.counts = raw.counts ?? {};
      this.since = raw.since ?? null;
    } catch {
      /* first run */
    }
  }

  add(version: string, key: string): void {
    this.since ??= new Date(this.now()).toISOString();
    const v = (this.counts[version] ??= {});
    v[key] = (v[key] ?? 0) + 1;
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), 2000);
      this.timer.unref?.();
    }
  }

  async flush(): Promise<void> {
    this.timer = null;
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await writeAtomic(this.file, JSON.stringify({ since: this.since, counts: this.counts }) + '\n', 0o600);
    } catch {
      /* counts are best-effort; the next increment retries */
    }
  }

  stats(): DownloadStats {
    const byPlatform: Record<string, number> = {};
    let total = 0;
    for (const v of Object.values(this.counts)) {
      for (const [k, n] of Object.entries(v)) {
        byPlatform[k] = (byPlatform[k] ?? 0) + n;
        total += n;
      }
    }
    return { total, by_platform: byPlatform, by_version: this.counts, since: this.since };
  }
}

// ------------------------------------------------------------------------------------------- routes

export interface ReleaseRouteDeps {
  store: ReleaseStore;
  counter: DownloadCounter;
  verifyOidc: GithubOidcVerifier;
  /** Policy for /v1/releases/*: repository, ref, desktop-build workflow, audience. */
  releasePolicy: GithubOidcPolicy;
  /** Policy for /v1/deploy (server-deploy workflow). null -> /v1/deploy answers 404. */
  deployPolicy: GithubOidcPolicy | null;
  /** Directory shared with the host's airbridge-autodeploy (request in, status.json out). */
  deployDir: string | null;
  adminToken: string | null;
  maxUploadBytes?: number;
  clientIp: (c: Context) => string;
  now: () => number;
  log: { info(m: string, f?: Record<string, unknown>): void; warn(m: string, f?: Record<string, unknown>): void; error(m: string, f?: Record<string, unknown>): void };
}

export function registerReleaseRoutes(app: Hono, deps: ReleaseRouteDeps): void {
  const { store, counter, log } = deps;
  const maxBytes = deps.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const ciLimiter = new RateLimiter(30, 60_000, deps.now);
  let uploadsInFlight = 0;

  const ci = async (c: Context, policy: GithubOidcPolicy) => {
    if (!ciLimiter.allow(deps.clientIp(c))) return { res: c.json({ error: 'rate_limited' }, 429) };
    try {
      return { claims: await deps.verifyOidc(c.req.header('authorization'), policy) };
    } catch (e) {
      const reason = e instanceof OidcError ? e.message.split(':')[0] : 'invalid_token';
      log.warn('ci_auth_rejected', { path: c.req.path, reason });
      return { res: c.json({ error: 'unauthorized', reason }, 401) };
    }
  };

  app.post('/v1/releases/upload', async (c) => {
    const auth = await ci(c, deps.releasePolicy);
    if (auth.res) return auth.res;
    const name = c.req.query('name') ?? '';
    const inst = parseInstallerName(name);
    if (!inst) return c.json({ error: 'bad_name' }, 400);
    const declared = c.req.header('content-length');
    if (declared !== undefined && Number(declared) > maxBytes) return c.json({ error: 'payload_too_large' }, 413);
    const id = releaseId(inst.version, auth.claims.sha);
    if (await store.isPublished(id)) return c.json({ error: 'already_published', id }, 409);
    const body = c.req.raw.body;
    if (!body) return c.json({ error: 'empty_body' }, 400);
    if (uploadsInFlight >= 4) return c.json({ error: 'busy' }, 503);
    uploadsInFlight++;
    try {
      const r = await store.saveUpload(id, name, Readable.fromWeb(body as unknown as WebReadableStream<Uint8Array>), maxBytes);
      log.info('release_uploaded', { id, name, size: r.size, run: auth.claims.runId });
      return c.json({ id, name, size: r.size, sha256: r.sha256, url: `/downloads/${id}/${name}` }, 201);
    } catch (e) {
      if (e instanceof CapExceeded) return c.json({ error: 'payload_too_large' }, 413);
      log.error('release_upload_failed', { id, name, err: (e as Error).message });
      return c.json({ error: 'upload_failed' }, 500);
    } finally {
      uploadsInFlight--;
    }
  });

  app.post('/v1/releases/publish', async (c) => {
    const auth = await ci(c, deps.releasePolicy);
    if (auth.res) return auth.res;
    let version: unknown;
    try {
      version = ((await c.req.json()) as { version?: unknown }).version;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (typeof version !== 'string' || !VERSION_RE.test(version)) return c.json({ error: 'bad_version' }, 400);
    try {
      const m = await store.publish(version, auth.claims.sha);
      log.info('release_published', { id: m.id, files: m.files.length, run: auth.claims.runId });
      return c.json(m);
    } catch (e) {
      if (e instanceof PublishError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  app.post('/v1/releases/rollback', async (c) => {
    if (!deps.adminToken || !bearerMatches(c.req.header('authorization'), deps.adminToken)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    let id: unknown;
    try {
      id = ((await c.req.json()) as { id?: unknown }).id;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (typeof id !== 'string' || !RELEASE_ID.test(id)) return c.json({ error: 'bad_id' }, 400);
    try {
      const m = await store.rollback(id);
      log.warn('release_rolled_back', { id });
      return c.json(m);
    } catch (e) {
      if (e instanceof PublishError) return c.json({ error: e.message }, 404);
      throw e;
    }
  });

  // Caddy forward_auth for GET /downloads/<id>/<name>. Never blocks a download (always 200). Counts a full GET or
  // the first range of a ranged one, once per client and file per 10 minutes. Caddy refuses this path from outside.
  const seen = new Map<string, number>();
  app.get('/v1/downloads/count', (c) => {
    try {
      const method = c.req.header('x-forwarded-method') ?? 'GET';
      const uri = c.req.header('x-forwarded-uri') ?? '';
      const range = c.req.header('range');
      const m = /^\/downloads\/([^/?#]+)\/([^/?#]+)(?:\?.*)?$/.exec(uri);
      const inst = m ? parseInstallerName(decodeURIComponent(m[2]!)) : null;
      if (method === 'GET' && m && RELEASE_ID.test(m[1]!) && inst && (!range || /^bytes=0-/.test(range))) {
        const t = deps.now();
        const key = `${deps.clientIp(c)}|${m[1]}|${m[2]}`;
        const last = seen.get(key);
        if (last === undefined || t - last > 10 * 60_000) {
          if (seen.size > 50_000) seen.clear();
          seen.set(key, t);
          counter.add(inst.version, `${inst.platform}-${inst.arch}`);
        }
      }
    } catch {
      /* never block a download */
    }
    return c.body(null, 200);
  });

  // ---------------------------------------------------------------- self-deploy (host does the work)
  if (deps.deployPolicy && deps.deployDir) {
    const deployDir = deps.deployDir;
    const policy = deps.deployPolicy;
    app.post('/v1/deploy', async (c) => {
      const auth = await ci(c, policy);
      if (auth.res) return auth.res;
      const req = { commit: auth.claims.sha, run_id: auth.claims.runId, requested_at: new Date(deps.now()).toISOString() };
      try {
        await writeAtomic(path.join(deployDir, 'request.json'), JSON.stringify(req) + '\n', 0o644);
      } catch (e) {
        log.error('deploy_request_failed', { err: (e as Error).message });
        return c.json({ error: 'deploy_unavailable' }, 503);
      }
      log.info('deploy_requested', req);
      return c.json({ accepted: true, commit: req.commit }, 202);
    });
    app.get('/v1/deploy/status', async (c) => {
      try {
        const s = JSON.parse(await fsp.readFile(path.join(deployDir, 'status.json'), 'utf8')) as Record<string, unknown>;
        const pick = (k: string) => (typeof s[k] === 'string' ? (s[k] as string).slice(0, 200) : null);
        return c.json({ commit: pick('commit'), state: pick('state'), requested: pick('requested'), finished_at: pick('finished_at') });
      } catch {
        return c.json({ commit: null, state: 'unknown', requested: null, finished_at: null });
      }
    });
  }
}
