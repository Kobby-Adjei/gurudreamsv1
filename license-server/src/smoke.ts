/**
 * TEMPORARY deployment smoke test (deploy/digitalocean/README.md "End-to-end smoke test").
 *
 *  POST /v1/admin/smoke/keys      Bearer WAITLIST_ADMIN_TOKEN -> throwaway Headscale user `smoke-<8 hex>` + 2 single-use
 *                                 pre-auth keys (10 min), returned once. At most 3 calls per process.
 *  POST /v1/admin/smoke/cleanup   Bearer WAITLIST_ADMIN_TOKEN -> delete every `smoke-*` user and its nodes, then write
 *                                 `<SMOKE_STATE_DIR>/disabled`: from then on every /v1/admin/smoke/* route is 404 for good
 *                                 (the host also turns SMOKE_TEST off when that file appears).
 *
 * Registered only when SMOKE_TEST=1 and Headscale and WAITLIST_ADMIN_TOKEN are configured; also 404 after
 * SMOKE_TEST_UNTIL (unix seconds). Lets the operator run two real sidecars without a Clerk sign-in. Keys are never
 * logged. Customer users are `u-<hex>`, so the `smoke-` prefix can never match one.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context, Hono } from 'hono';
import { HeadscaleError } from './headscale.js';
import type { NetworkConfig, NetworkLogger } from './network.js';
import { RateLimiter } from './rateLimit.js';
import { bearerMatches } from './waitlist.js';

export interface SmokeConfig {
  /** SMOKE_STATE_DIR (default /data/smoke): holds the one-way `disabled` marker. */
  stateDir: string;
  /** SMOKE_TEST_UNTIL: unix seconds after which the routes are 404; null = no deadline. */
  until: number | null;
}

export interface SmokeRouteDeps {
  smoke: SmokeConfig;
  network: NetworkConfig;
  adminToken: string;
  clientIp: (c: Context) => string;
  now: () => number;
  log: NetworkLogger;
  maxIssuances?: number;
}

export const SMOKE_USER = /^smoke-[0-9a-f]{8}$/;
const SMOKE_KEY_TTL_SECONDS = 600;

export function smokeDisabledMarker(cfg: SmokeConfig): string {
  return join(cfg.stateDir, 'disabled');
}

export function registerSmokeRoutes(app: Hono, deps: SmokeRouteDeps): void {
  const { log, network } = deps;
  const limiter = new RateLimiter(10, 60_000, deps.now);
  const maxIssuances = deps.maxIssuances ?? 3;
  let issued = 0;
  const marker = smokeDisabledMarker(deps.smoke);

  const active = (): boolean =>
    !existsSync(marker) && (deps.smoke.until === null || Math.floor(deps.now() / 1000) < deps.smoke.until);

  app.use('/v1/admin/smoke/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!active()) return c.json({ error: 'not_found' }, 404);
    if (!limiter.allow(deps.clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
    if (!bearerMatches(c.req.header('authorization'), deps.adminToken)) {
      log.warn('smoke_admin_unauthorized');
      return c.json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
    }
    await next();
  });

  const failed = (c: Context, what: string, e: unknown) => {
    log.error(what, { err: e instanceof HeadscaleError ? e.message : 'unexpected_error' });
    return c.json({ error: 'upstream_unavailable' }, 502);
  };

  app.post('/v1/admin/smoke/keys', async (c) => {
    if (issued >= maxIssuances) return c.json({ error: 'smoke_limit_reached' }, 429);
    issued += 1;
    const name = `smoke-${randomBytes(4).toString('hex')}`;
    try {
      const user = await network.client.createUser(name);
      const expiresAtSec = Math.floor(deps.now() / 1000) + SMOKE_KEY_TTL_SECONDS;
      const keys: string[] = [];
      for (let i = 0; i < 2; i += 1) {
        const k = await network.client.createPreAuthKey({
          userId: user.id,
          reusable: false,
          ephemeral: false,
          expiration: new Date(expiresAtSec * 1000),
        });
        keys.push(k.key);
      }
      log.warn('SMOKE_KEYS_ISSUED', { hsUser: name, count: keys.length, ttl: SMOKE_KEY_TTL_SECONDS });
      return c.json({ user: name, login_server: network.loginServer, auth_keys: keys, expires_at: expiresAtSec });
    } catch (e) {
      return failed(c, 'smoke_keys_failed', e);
    }
  });

  app.post('/v1/admin/smoke/cleanup', async (c) => {
    let removedUsers = 0;
    let removedNodes = 0;
    try {
      for (const user of await network.client.listUsers()) {
        if (!SMOKE_USER.test(user.name)) continue;
        for (const node of await network.client.listNodesByUser(user.name)) {
          if (node.user && node.user.name !== user.name) continue;
          await network.client.deleteNode(node.id);
          removedNodes += 1;
        }
        await network.client.deleteUser(user.id);
        removedUsers += 1;
      }
    } catch (e) {
      return failed(c, 'smoke_cleanup_failed', e);
    }
    try {
      mkdirSync(deps.smoke.stateDir, { recursive: true, mode: 0o700 });
      writeFileSync(marker, `${new Date(deps.now()).toISOString()}\n`, { mode: 0o600 });
    } catch (e) {
      log.error('smoke_disable_failed', { err: (e as Error).message });
      return c.json({ error: 'disable_failed', removed_users: removedUsers, removed_nodes: removedNodes }, 500);
    }
    log.warn('SMOKE_DISABLED', { removedUsers, removedNodes });
    return c.json({ removed_users: removedUsers, removed_nodes: removedNodes, disabled: true });
  });
}
