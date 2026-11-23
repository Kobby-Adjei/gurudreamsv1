/**
 * Phase 3 "Invisible Network" endpoints (PHASE3_PLAN.md §2 "License server").
 *
 *  POST /v1/network/preauth-key          Clerk JWT + entitlement -> single-use, non-ephemeral Headscale key
 *  POST /v1/network/devices/:id/remove   delete one of the caller's own nodes (other users' nodes -> 404)
 *
 * One Headscale user per customer, named `u-<sha256(clerk sub)[:20]>` (no PII leaves this server).
 * Pre-auth keys are secrets: never logged, served with `Cache-Control: no-store`.
 */
import { createHash } from 'node:crypto';
import type { Context, Hono } from 'hono';
import type { AuthenticatedUser } from './clerkAuth.js';
import { HeadscaleError, type HeadscaleApi } from './headscale.js';
import { RateLimiter } from './rateLimit.js';
import { isEntitled, type SubscriptionStore } from './store.js';

export interface NetworkLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface NetworkConfig {
  client: HeadscaleApi;
  /** HEADSCALE_PUBLIC_URL — the `--login-server` clients use. */
  loginServer: string;
  /** PREAUTH_TTL_SECONDS (default 600). */
  preauthTtlSeconds: number;
}

export interface NetworkRouteDeps {
  network: NetworkConfig | null;
  store: SubscriptionStore;
  authenticate: (c: Context) => Promise<AuthenticatedUser | null>;
  clientIp: (c: Context) => string;
  now: () => number;
  log: NetworkLogger;
  limits?: { perUserPerMinute?: number; globalPerDay?: number; perIpPerMinute?: number; removePerUserPerMinute?: number };
}

const NODE_ID = /^[1-9][0-9]{0,19}$/;
const DAY_MS = 24 * 3600 * 1000;

/** Headscale user name for a Clerk subject: `u-` + first 20 hex chars of sha256(sub). */
export function headscaleUserName(sub: string): string {
  return `u-${createHash('sha256').update(sub, 'utf8').digest('hex').slice(0, 20)}`;
}

function upstreamFailed(c: Context, log: NetworkLogger, what: string, e: unknown) {
  // Only our own error summary (method/route/status) is logged; upstream bodies never reach us.
  log.error(what, { err: e instanceof HeadscaleError ? e.message : 'unexpected_error' });
  return c.json({ error: 'upstream_unavailable' }, 502);
}

export function registerNetworkRoutes(app: Hono, deps: NetworkRouteDeps): void {
  const { log } = deps;
  const perUser = new RateLimiter(deps.limits?.perUserPerMinute ?? 5, 60_000, deps.now);
  const removePerUser = new RateLimiter(deps.limits?.removePerUserPerMinute ?? 20, 60_000, deps.now);
  const perIp = new RateLimiter(deps.limits?.perIpPerMinute ?? 60, 60_000, deps.now);
  const global = new RateLimiter(deps.limits?.globalPerDay ?? 1000, DAY_MS, deps.now);

  const unavailable = (c: Context) => c.json({ error: 'network_unavailable' }, 503);
  const unauthorized = (c: Context) => c.json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });

  app.post('/v1/network/preauth-key', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!perIp.allow(deps.clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
    const user = await deps.authenticate(c);
    if (!user) return unauthorized(c);
    const net = deps.network;
    if (!net) return unavailable(c);
    if (!perUser.allow(user.sub)) return c.json({ error: 'rate_limited' }, 429);

    const rec = await deps.store.get(user.sub);
    if (!rec || !isEntitled(rec.status)) return c.json({ error: 'subscription_required', status: rec?.status ?? 'none' }, 402);

    if (!global.allow('global')) {
      log.warn('network_global_limit_reached');
      return c.json({ error: 'rate_limited' }, 429);
    }

    const name = headscaleUserName(user.sub);
    try {
      const hsUser = await net.client.ensureUser(name);
      const expiresAtSec = Math.floor(deps.now() / 1000) + net.preauthTtlSeconds;
      const key = await net.client.createPreAuthKey({
        userId: hsUser.id,
        reusable: false,
        ephemeral: false,
        expiration: new Date(expiresAtSec * 1000),
      });
      log.info('network_preauth_key_issued', { hsUser: name, ttl: net.preauthTtlSeconds });
      return c.json({ auth_key: key.key, login_server: net.loginServer, expires_at: expiresAtSec }, 200, {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
      });
    } catch (e) {
      return upstreamFailed(c, log, 'network_preauth_key_failed', e);
    }
  });

  app.post('/v1/network/devices/:id/remove', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!perIp.allow(deps.clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
    const user = await deps.authenticate(c);
    if (!user) return unauthorized(c);
    const net = deps.network;
    if (!net) return unavailable(c);
    if (!removePerUser.allow(user.sub)) return c.json({ error: 'rate_limited' }, 429);

    const id = c.req.param('id');
    if (!NODE_ID.test(id)) return c.json({ error: 'not_found' }, 404);
    const name = headscaleUserName(user.sub);
    try {
      const node = await net.client.getNode(id);
      // Someone else's node and a non-existent node are indistinguishable to the caller.
      if (!node || !node.user || node.user.name !== name) return c.json({ error: 'not_found' }, 404);
      await net.client.deleteNode(id);
      log.info('network_device_removed', { hsUser: name, nodeId: id });
      return c.json({ removed: true });
    } catch (e) {
      return upstreamFailed(c, log, 'network_device_remove_failed', e);
    }
  });
}

/**
 * Subscription lapsed: delete every Headscale node of that customer so the private network stops
 * working immediately. Best-effort — failures are logged and never fail the Stripe webhook.
 * Re-subscribing re-enrolls automatically (the app sees NeedsLogin and fetches a fresh key).
 */
export async function revokeUserNodes(network: NetworkConfig | null, sub: string, log: NetworkLogger): Promise<number> {
  if (!network) return 0;
  const name = headscaleUserName(sub);
  try {
    const user = await network.client.findUserByName(name);
    if (!user) return 0;
    const nodes = await network.client.listNodesByUser(name);
    let removed = 0;
    for (const n of nodes) {
      if (n.user && n.user.name !== name) continue; // defensive: never touch another user's node
      try {
        await network.client.deleteNode(n.id);
        removed += 1;
      } catch (e) {
        log.warn('network_revoke_node_failed', { hsUser: name, nodeId: n.id, err: e instanceof HeadscaleError ? e.message : 'unexpected_error' });
      }
    }
    log.info('network_nodes_revoked', { hsUser: name, removed, total: nodes.length });
    return removed;
  } catch (e) {
    log.warn('network_revoke_failed', { hsUser: name, err: e instanceof HeadscaleError ? e.message : 'unexpected_error' });
    return 0;
  }
}
