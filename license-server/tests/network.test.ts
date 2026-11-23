import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { createApp, type Logger } from '../src/app.js';
import { createClerkVerifier } from '../src/clerkAuth.js';
import { loadConfig } from '../src/config.js';
import { createHeadscaleClient, HeadscaleError } from '../src/headscale.js';
import { createLicenseSigner } from '../src/licenseToken.js';
import { EXPECTED_POLICY, headscaleUserName, hujsonToJson, isExpectedPolicy, revokeUserNodes } from '../src/network.js';
import { readFileSync } from 'node:fs';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySubscriptionStore } from '../src/store.js';
import type { SmokeConfig } from '../src/smoke.js';
import { JsonlWaitlistStore } from '../src/waitlist.js';
import { AUDIENCE, clerkKeys, ed25519Pair, FAKE_STRIPE_KEY, FakeBilling, ISSUER, KID, PRICE_ID, USER, WEBHOOK_SECRET } from './helpers.js';

const HS_URL = 'https://hs-api.test.example';
const LOGIN_SERVER = 'https://hs.test.example';
// Built at runtime so secret scanners never see key-shaped literals.
const HS_API_KEY = ['hskey', 'api', 'abcdefghijkl', 'offlinesecretvalue0000'].join('-');
const OTHER_USER = 'user_9zzzOTHER77';

interface Call {
  method: string;
  path: string;
  auth: string | null;
  body: any;
}

/** In-memory Headscale v0.29.7 REST API (protojson camelCase, uint64 ids as strings). */
class FakeHeadscale {
  users: Array<{ id: string; name: string }> = [];
  nodes: Array<{ id: string; givenName: string; user: { id: string; name: string } }> = [];
  calls: Call[] = [];
  policyCalls: Call[] = [];
  issued: string[] = [];
  nextId = 1;
  down = false;
  /** Simulate a concurrent create: POST /user inserts the user but answers 500 (unique violation). */
  raceOnCreate = false;
  failStatus: Record<string, number> = {};
  policy: string = JSON.stringify(EXPECTED_POLICY);
  policyDown = false;

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const call = { method, path: url.pathname + url.search, auth: headers.get('authorization'), body };
    // Policy checks are tracked separately so per-request call sequences stay readable.
    if (url.pathname === '/api/v1/policy') this.policyCalls.push(call);
    else this.calls.push(call);
    if (this.down || (this.policyDown && url.pathname === '/api/v1/policy')) throw new TypeError('fetch failed');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    if (url.origin !== HS_URL) return new Response('wrong host', { status: 599 });
    if (headers.get('authorization') !== `Bearer ${HS_API_KEY}`) return new Response('Unauthorized', { status: 401 });
    const forced = this.failStatus[`${method} ${url.pathname}`];
    if (forced) return new Response('upstream secret detail: db path /var/lib/headscale', { status: forced });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

    if (url.pathname === '/api/v1/policy' && method === 'GET') {
      return json({ policy: this.policy, updatedAt: null });
    }
    if (url.pathname === '/api/v1/user' && method === 'GET') {
      const name = url.searchParams.get('name');
      return json({ users: this.users.filter((u) => !name || u.name === name) });
    }
    if (url.pathname === '/api/v1/user' && method === 'POST') {
      if (this.users.some((u) => u.name === body.name)) {
        return json({ code: 13, message: 'creating user: UNIQUE constraint failed: users.name' }, 500);
      }
      const u = { id: String(this.nextId++), name: body.name };
      this.users.push(u);
      if (this.raceOnCreate) return json({ code: 13, message: 'creating user: UNIQUE constraint failed' }, 500);
      return json({ user: { ...u, createdAt: new Date().toISOString(), displayName: '', email: '' } });
    }
    if (url.pathname === '/api/v1/preauthkey' && method === 'POST') {
      const user = this.users.find((u) => u.id === String(body.user));
      if (!user) return json({ code: 2, message: 'user not found' }, 500);
      const key = `hskey-auth-${'k'.repeat(12)}-${'s'.repeat(20)}${this.issued.length}`;
      this.issued.push(key);
      return json({
        preAuthKey: {
          user,
          id: String(this.issued.length),
          key,
          reusable: body.reusable,
          ephemeral: body.ephemeral,
          used: false,
          expiration: body.expiration,
          createdAt: new Date().toISOString(),
          aclTags: [],
        },
      });
    }
    const um = /^\/api\/v1\/user\/([0-9]+)$/.exec(url.pathname);
    if (um && method === 'DELETE') {
      const i = this.users.findIndex((u) => u.id === um[1]);
      if (i < 0) return json({ code: 5, message: 'user not found' }, 404);
      if (this.nodes.some((n) => n.user.id === um[1])) return json({ code: 13, message: 'user still has nodes' }, 500);
      this.users.splice(i, 1);
      return json({});
    }
    const m = /^\/api\/v1\/node\/([0-9]+)$/.exec(url.pathname);
    if (m && method === 'GET') {
      const n = this.nodes.find((x) => x.id === m[1]);
      return n ? json({ node: { ...n, name: n.givenName, ipAddresses: ['100.64.0.1'], online: true } }) : json({ code: 5, message: 'node not found' }, 404);
    }
    if (m && method === 'DELETE') {
      const i = this.nodes.findIndex((x) => x.id === m[1]);
      if (i < 0) return json({ code: 5, message: 'node not found' }, 404);
      this.nodes.splice(i, 1);
      return json({});
    }
    if (url.pathname === '/api/v1/node' && method === 'GET') {
      const name = url.searchParams.get('user');
      if (name && !this.users.some((u) => u.name === name)) return json({ code: 2, message: 'record not found' }, 500);
      return json({ nodes: this.nodes.filter((n) => !name || n.user.name === name) });
    }
    return json({ code: 5, message: 'Not Found' }, 404);
  };

  addNode(ownerName: string): string {
    let user = this.users.find((u) => u.name === ownerName);
    if (!user) {
      user = { id: String(this.nextId++), name: ownerName };
      this.users.push(user);
    }
    const id = String(this.nextId++);
    this.nodes.push({ id, givenName: `airbridge-${id}`, user });
    return id;
  }
}

function captureLogger() {
  const lines: string[] = [];
  const rec = (level: string) => (msg: string, f?: Record<string, unknown>) => void lines.push(JSON.stringify({ level, msg, ...f }));
  const logger: Logger = { info: rec('info'), warn: rec('warn'), error: rec('error') };
  return { lines, logger };
}

async function harness(
  opts: {
    network?: boolean;
    perUser?: number;
    global?: number;
    now?: () => number;
    setup?: (hs: FakeHeadscale) => void;
    enforceEntitlement?: boolean;
    smoke?: SmokeConfig | null;
    adminToken?: string | null;
  } = {},
) {
  const hs = new FakeHeadscale();
  opts.setup?.(hs); // before createApp: the policy guard checks at boot
  const store = new InMemorySubscriptionStore();
  const billing = new FakeBilling();
  const clerk = await clerkKeys();
  const stripe = new Stripe(FAKE_STRIPE_KEY);
  const { lines, logger } = captureLogger();
  const t0 = 1_800_000_000_000;
  const now = opts.now ?? (() => t0);
  const network =
    opts.network === false
      ? null
      : { client: createHeadscaleClient({ baseUrl: HS_URL, apiKey: HS_API_KEY, fetch: hs.fetch as typeof fetch }), loginServer: LOGIN_SERVER, preauthTtlSeconds: 600 };
  const app = createApp({
    store,
    billing,
    verifyWebhook: (raw, sig, secret) => stripe.webhooks.constructEvent(raw, sig, secret),
    webhookSecret: WEBHOOK_SECRET,
    clerk: createClerkVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks: clerk.jwks }),
    signer: createLicenseSigner({ privateKey: ed25519Pair().privateKey, kid: KID, ttlSeconds: 259200 }),
    priceId: PRICE_ID,
    publicBaseUrl: 'https://license.test.example',
    logger,
    now,
    rateLimit: {
      verifyPerMinute: 1000,
      checkoutPerMinute: 1000,
      networkPerUserPerMinute: opts.perUser ?? 1000,
      networkGlobalPerDay: opts.global ?? 1000,
      networkPerIpPerMinute: 1000,
    },
    network,
    ...(opts.enforceEntitlement === undefined ? {} : { enforceEntitlement: opts.enforceEntitlement }),
    smoke: opts.smoke ?? null,
    waitlist: opts.adminToken === undefined ? null : { store: new JsonlWaitlistStore(join(mkdtempSync(join(tmpdir(), 'ab-wl-')), 'w.jsonl')), adminToken: opts.adminToken },
  });
  const entitle = (sub = USER, status: 'active' | 'trialing' | 'past_due' | 'canceled' = 'active') =>
    store.upsert({ clerkUserId: sub, stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', status, currentPeriodEnd: null, lastEventCreated: 1 });
  const preauth = (token?: string) =>
    app.request('/v1/network/preauth-key', { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} });
  const remove = (id: string, token?: string) =>
    app.request(`/v1/network/devices/${id}/remove`, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} });
  let seq = 0;
  const sendEvent = async (type: string, object: Record<string, unknown>) => {
    const payload = JSON.stringify({ id: `evt_n${++seq}`, object: 'event', type, created: 1, data: { object }, livemode: false, api_version: '2024-06-20' });
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    return app.request('/v1/stripe/webhook', { method: 'POST', body: payload, headers: { 'stripe-signature': header } });
  };
  return { hs, store, billing, clerk, app, lines, entitle, preauth, remove, sendEvent };
}

const expectedName = (sub: string) => `u-${createHash('sha256').update(sub).digest('hex').slice(0, 20)}`;

describe('headscaleUserName', () => {
  it('is u- + first 20 hex chars of sha256(sub), contains no PII and is a valid Headscale username', () => {
    const n = headscaleUserName(USER);
    expect(n).toBe(expectedName(USER));
    expect(n).toMatch(/^u-[0-9a-f]{20}$/);
    expect(n).not.toContain(USER);
    expect(headscaleUserName(OTHER_USER)).not.toBe(n);
  });
});

describe('POST /v1/network/preauth-key', () => {
  it('401 without/with a bad token, and never calls Headscale', async () => {
    const h = await harness();
    expect((await h.preauth()).status).toBe(401);
    expect((await h.preauth('a.b.c')).status).toBe(401);
    expect(h.hs.calls).toHaveLength(0);
  });

  it('402 when not entitled (none / past_due / canceled), never calls Headscale', async () => {
    const h = await harness();
    const token = await h.clerk.mint();
    let res = await h.preauth(token);
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: 'subscription_required', status: 'none' });
    for (const s of ['past_due', 'canceled'] as const) {
      await h.store.upsert({ clerkUserId: USER, stripeCustomerId: null, stripeSubscriptionId: 'sub_1', status: s, currentPeriodEnd: null, lastEventCreated: 2 });
      res = await h.preauth(token);
      expect(res.status).toBe(402);
    }
    expect(h.hs.calls).toHaveLength(0);
  });

  it('enforceEntitlement: true (explicit) behaves exactly like the default: 402', async () => {
    const h = await harness({ enforceEntitlement: true });
    const res = await h.preauth(await h.clerk.mint());
    expect(res.status).toBe(402);
    expect(h.lines.some((l) => l.includes('ENTITLEMENT_NOT_ENFORCED'))).toBe(false);
    expect(h.hs.calls).toHaveLength(0);
  });

  describe('ENFORCE_ENTITLEMENT=false (preview mode)', () => {
    it('issues a key to an unsubscribed signed-in user and logs the would-be 402 (no key in logs)', async () => {
      const h = await harness({ enforceEntitlement: false });
      const res = await h.preauth(await h.clerk.mint());
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = (await res.json()) as { auth_key: string };
      expect(body.auth_key).toBe(h.hs.issued[0]);
      const line = h.lines.find((l) => l.includes('ENTITLEMENT_NOT_ENFORCED'));
      expect(line).toBeDefined();
      expect(JSON.parse(line!)).toMatchObject({ level: 'warn', status: 'none', wouldBe: 402, hsUser: expectedName(USER) });
      expect(h.lines.join('\n')).not.toContain(body.auth_key);
      expect(h.lines.join('\n')).not.toContain(USER);
    });

    it('logs the lapsed status (past_due / canceled) and still issues', async () => {
      const h = await harness({ enforceEntitlement: false });
      await h.entitle(USER, 'canceled');
      expect((await h.preauth(await h.clerk.mint())).status).toBe(200);
      expect(h.lines.some((l) => l.includes('ENTITLEMENT_NOT_ENFORCED') && l.includes('"status":"canceled"'))).toBe(true);
    });

    it('does not log ENTITLEMENT_NOT_ENFORCED for an entitled user', async () => {
      const h = await harness({ enforceEntitlement: false });
      await h.entitle();
      expect((await h.preauth(await h.clerk.mint())).status).toBe(200);
      expect(h.lines.some((l) => l.includes('ENTITLEMENT_NOT_ENFORCED'))).toBe(false);
    });

    it('still requires Clerk auth, still rate limits, still honors the policy guard and 503 without Headscale', async () => {
      const h = await harness({ enforceEntitlement: false, perUser: 2 });
      expect((await h.preauth()).status).toBe(401);
      expect((await h.preauth('a.b.c')).status).toBe(401);
      expect(h.hs.calls).toHaveLength(0);
      const token = await h.clerk.mint();
      expect((await h.preauth(token)).status).toBe(200);
      expect((await h.preauth(token)).status).toBe(200);
      expect((await h.preauth(token)).status).toBe(429);

      const bad = await harness({ enforceEntitlement: false, setup: (hs) => (hs.policy = '{}') });
      expect((await bad.preauth(await bad.clerk.mint())).status).toBe(503);
      expect(bad.hs.issued).toHaveLength(0);

      const none = await harness({ enforceEntitlement: false, network: false });
      expect((await none.preauth(await none.clerk.mint())).status).toBe(503);
    });

    it('leaves /v1/license/verify unchanged (still 402 without a subscription)', async () => {
      const h = await harness({ enforceEntitlement: false });
      const res = await h.app.request('/v1/license/verify', { method: 'POST', headers: { authorization: `Bearer ${await h.clerk.mint()}` } });
      expect(res.status).toBe(402);
    });
  });

  it('issues a single-use, non-ephemeral 600 s key for the hashed user (no-store, no key in logs)', async () => {
    const h = await harness();
    await h.entitle();
    const res = await h.preauth(await h.clerk.mint());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { auth_key: string; login_server: string; expires_at: number };
    expect(body).toEqual({ auth_key: h.hs.issued[0], login_server: LOGIN_SERVER, expires_at: 1_800_000_000 + 600 });

    const name = expectedName(USER);
    expect(h.hs.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /api/v1/user?name=${name}`,
      'POST /api/v1/user',
      'POST /api/v1/preauthkey',
    ]);
    expect(h.hs.calls.every((c) => c.auth === `Bearer ${HS_API_KEY}`)).toBe(true);
    expect(h.hs.calls[1]!.body).toEqual({ name });
    const pak = h.hs.calls[2]!.body;
    expect(pak).toEqual({ user: '1', reusable: false, ephemeral: false, expiration: new Date((1_800_000_000 + 600) * 1000).toISOString() });
    // F-1: tagged nodes escape autogroup:self — never request ACL tags.
    expect(pak).not.toHaveProperty('aclTags');
    expect(pak).not.toHaveProperty('acl_tags');
    expect(h.hs.policyCalls.length).toBeGreaterThanOrEqual(1);
    expect(h.hs.policyCalls.every((c) => c.auth === `Bearer ${HS_API_KEY}`)).toBe(true);
    // Neither the key nor the API key nor the Clerk sub is logged.
    const logs = h.lines.join('\n');
    expect(logs).not.toContain(body.auth_key);
    expect(logs).not.toContain(HS_API_KEY);
    expect(logs).not.toContain(USER);
  });

  it('user creation is idempotent: the second request reuses the existing Headscale user', async () => {
    const h = await harness();
    await h.entitle();
    const token = await h.clerk.mint();
    expect((await h.preauth(token)).status).toBe(200);
    h.hs.calls = [];
    expect((await h.preauth(token)).status).toBe(200);
    expect(h.hs.calls.map((c) => c.method + ' ' + c.path.split('?')[0])).toEqual(['GET /api/v1/user', 'POST /api/v1/preauthkey']);
    expect(h.hs.users).toHaveLength(1);
  });

  it('a concurrent create (Headscale answers 500 on the unique violation) re-GETs and succeeds', async () => {
    const h = await harness();
    await h.entitle();
    h.hs.raceOnCreate = true;
    const res = await h.preauth(await h.clerk.mint());
    expect(res.status).toBe(200);
    expect(h.hs.calls.map((c) => c.method + ' ' + c.path.split('?')[0])).toEqual([
      'GET /api/v1/user',
      'POST /api/v1/user',
      'GET /api/v1/user',
      'POST /api/v1/preauthkey',
    ]);
  });

  it('Headscale failures -> 502 without the upstream body', async () => {
    const h = await harness();
    await h.entitle();
    const token = await h.clerk.mint();
    h.hs.failStatus['POST /api/v1/preauthkey'] = 500;
    let res = await h.preauth(token);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ error: 'upstream_unavailable' }));
    expect(h.lines.join('\n')).not.toContain('upstream secret detail');

    h.hs.down = true;
    res = await h.preauth(token);
    expect(res.status).toBe(502);
  });

  it('rate limits 5/min per user and a global daily cap', async () => {
    let t = 1_800_000_000_000;
    const h = await harness({ perUser: 5, global: 1000, now: () => t });
    await h.entitle();
    const token = await h.clerk.mint();
    for (let i = 0; i < 5; i++) expect((await h.preauth(token)).status).toBe(200);
    expect((await h.preauth(token)).status).toBe(429);
    t += 60_000;
    expect((await h.preauth(token)).status).toBe(200);

    const g = await harness({ perUser: 1000, global: 2 });
    await g.entitle();
    await g.entitle(OTHER_USER);
    expect((await g.preauth(await g.clerk.mint())).status).toBe(200);
    expect((await g.preauth(await g.clerk.mint({ sub: OTHER_USER }))).status).toBe(200);
    expect((await g.preauth(await g.clerk.mint({ sub: OTHER_USER }))).status).toBe(429);
  });

  it('defaults to 5/min per user when no override is configured', async () => {
    const h = await harness();
    // Re-create without the per-user override.
    const app = createApp({
      store: h.store,
      billing: h.billing,
      verifyWebhook: () => {
        throw new Error('unused');
      },
      webhookSecret: WEBHOOK_SECRET,
      clerk: createClerkVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks: h.clerk.jwks }),
      signer: createLicenseSigner({ privateKey: ed25519Pair().privateKey, kid: KID, ttlSeconds: 259200 }),
      priceId: PRICE_ID,
      logger: { info() {}, warn() {}, error() {} },
      network: { client: createHeadscaleClient({ baseUrl: HS_URL, apiKey: HS_API_KEY, fetch: h.hs.fetch as typeof fetch }), loginServer: LOGIN_SERVER, preauthTtlSeconds: 600 },
    });
    await h.entitle();
    const token = await h.clerk.mint();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await app.request('/v1/network/preauth-key', { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it('503 when Headscale is not configured (dev)', async () => {
    const h = await harness({ network: false });
    await h.entitle();
    const token = await h.clerk.mint();
    expect((await h.preauth(token)).status).toBe(503);
    expect((await h.remove('5', token)).status).toBe(503);
    expect((await h.preauth()).status).toBe(401); // auth is still checked first
  });
});

describe('Headscale policy guard (PHASE3_SECURITY F-1)', () => {
  const POLICY_FILE = new URL('../headscale/policy.hujson', import.meta.url);

  it('the shipped policy.hujson is exactly the expected policy', () => {
    const raw = readFileSync(POLICY_FILE, 'utf8');
    expect(JSON.parse(raw)).toEqual(EXPECTED_POLICY);
    expect(isExpectedPolicy(raw)).toBe(true);
  });

  it('semantic comparison: ignores key order, whitespace, HuJSON comments and trailing commas; rejects anything else', () => {
    const hu = `// AirBridge
{ /* only rule */ "acls": [ { "dst": ["autogroup:self:8989"], "src": ["autogroup:member",], "proto": "tcp", "action": "accept", }, ], }`;
    expect(JSON.parse(hujsonToJson(hu))).toBeTruthy();
    expect(isExpectedPolicy(hu)).toBe(true);
    const bad = [
      '',
      '{}',
      '{"acls":[]}',
      'not json',
      JSON.stringify({ acls: [{ action: 'accept', src: ['autogroup:member'], dst: ['autogroup:self:8989'] }] }), // no proto
      JSON.stringify({ acls: [{ action: 'accept', proto: 'tcp', src: ['autogroup:member'], dst: ['autogroup:self:*'] }] }),
      JSON.stringify({ acls: [{ action: 'accept', proto: 'tcp', src: ['*'], dst: ['autogroup:self:8989'] }] }),
      JSON.stringify({ ...EXPECTED_POLICY, groups: { 'group:x': ['a@'] } }),
      JSON.stringify({ acls: [...EXPECTED_POLICY.acls, { action: 'accept', src: ['*'], dst: ['*:*'] }] }),
      '{"acls":[{"action":"accept","proto":"tcp","src":["autogroup:member"],"dst":["autogroup:self:8989"]}]} // "x": ",]"',
    ];
    for (const b of bad.slice(0, -1)) expect(isExpectedPolicy(b), b).toBe(false);
    expect(isExpectedPolicy(bad[bad.length - 1]!)).toBe(true); // trailing comment only
  });

  it('mismatching policy -> 503, no key minted, logged loudly', async () => {
    const h = await harness({ setup: (hs) => (hs.policy = JSON.stringify({ acls: [{ action: 'accept', src: ['*'], dst: ['*:*'] }] })) });
    await h.entitle();
    const res = await h.preauth(await h.clerk.mint());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'network_unavailable' });
    expect(h.hs.calls.some((c) => c.path.startsWith('/api/v1/preauthkey'))).toBe(false);
    expect(h.lines.some((l) => l.includes('NETWORK_POLICY_MISMATCH') && l.includes('"level":"error"'))).toBe(true);
  });

  it('empty policy (Headscale allow-all) -> 503', async () => {
    const h = await harness({ setup: (hs) => (hs.policy = '') });
    await h.entitle();
    expect((await h.preauth(await h.clerk.mint())).status).toBe(503);
  });

  it('unreachable policy endpoint -> 503; recovers after the retry window once the policy is correct', async () => {
    let t = 1_800_000_000_000;
    const h = await harness({ now: () => t, setup: (hs) => (hs.policyDown = true) });
    await h.entitle();
    const token = await h.clerk.mint();
    // Let the boot check settle.
    await new Promise((r) => setTimeout(r, 0));
    expect((await h.preauth(token)).status).toBe(503);
    expect(h.lines.some((l) => l.includes('NETWORK_POLICY_UNVERIFIABLE'))).toBe(true);
    h.hs.policyDown = false;
    expect((await h.preauth(token)).status).toBe(503); // still inside the 30 s retry window
    t += 31_000;
    expect((await h.preauth(token)).status).toBe(200);
  });

  it('policy changed after boot is caught by the periodic re-check (10 min max age)', async () => {
    let t = 1_800_000_000_000;
    const h = await harness({ now: () => t });
    await h.entitle();
    const token = await h.clerk.mint();
    expect((await h.preauth(token)).status).toBe(200);
    h.hs.policy = '{"acls":[{"action":"accept","src":["*"],"dst":["*:*"]}]}';
    t += 5 * 60_000;
    expect((await h.preauth(token)).status).toBe(200); // cached verdict still fresh
    t += 6 * 60_000;
    expect((await h.preauth(token)).status).toBe(503);
  });
});

describe('POST /v1/network/devices/:id/remove', () => {
  it('deletes the caller’s own node', async () => {
    const h = await harness();
    const id = h.hs.addNode(expectedName(USER));
    const res = await h.remove(id, await h.clerk.mint());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true });
    expect(h.hs.nodes).toHaveLength(0);
    expect(h.hs.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /api/v1/node/${id}`, `DELETE /api/v1/node/${id}`]);
  });

  it('cross-user remove -> 404 and nothing is deleted', async () => {
    const h = await harness();
    const id = h.hs.addNode(expectedName(OTHER_USER));
    const res = await h.remove(id, await h.clerk.mint());
    expect(res.status).toBe(404);
    expect(h.hs.nodes).toHaveLength(1);
    expect(h.hs.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('unknown node -> 404; malformed ids never reach Headscale; 401 without token', async () => {
    const h = await harness();
    const token = await h.clerk.mint();
    expect((await h.remove('999', token)).status).toBe(404);
    h.hs.calls = [];
    for (const bad of ['0', 'abc', '1e3', '-1', '123456789012345678901']) {
      expect((await h.remove(bad, token)).status, bad).toBe(404);
    }
    expect(h.hs.calls).toHaveLength(0);
    expect((await h.remove('1')).status).toBe(401);
  });

  it('Headscale failure -> 502', async () => {
    const h = await harness();
    const id = h.hs.addNode(expectedName(USER));
    h.hs.failStatus[`DELETE /api/v1/node/${id}`] = 500;
    const res = await h.remove(id, await h.clerk.mint());
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('upstream secret');
  });
});

describe('Stripe webhook -> Headscale node revocation', () => {
  it('deletes all of the user’s nodes when the subscription becomes inactive, and only theirs', async () => {
    const h = await harness();
    const mine = [h.hs.addNode(expectedName(USER)), h.hs.addNode(expectedName(USER))];
    const theirs = h.hs.addNode(expectedName(OTHER_USER));
    h.billing.setSub('sub_1', 'active');
    expect((await h.sendEvent('customer.subscription.created', { id: 'sub_1', metadata: { clerk_user_id: USER } })).status).toBe(200);
    expect(h.hs.calls).toHaveLength(0); // active: nothing revoked

    h.billing.setSub('sub_1', 'canceled');
    expect((await h.sendEvent('customer.subscription.deleted', { id: 'sub_1', metadata: { clerk_user_id: USER } })).status).toBe(200);
    expect(h.hs.nodes.map((n) => n.id)).toEqual([theirs]);
    expect(h.hs.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(mine.map((id) => `/api/v1/node/${id}`));
    expect(h.lines.some((l) => l.includes('network_nodes_revoked'))).toBe(true);
  });

  it('is best-effort: Headscale down still acknowledges the webhook and persists the status', async () => {
    const h = await harness();
    h.hs.addNode(expectedName(USER));
    h.hs.down = true;
    h.billing.setSub('sub_1', 'unpaid');
    const res = await h.sendEvent('customer.subscription.updated', { id: 'sub_1', metadata: { clerk_user_id: USER } });
    expect(res.status).toBe(200);
    expect((await h.store.get(USER))?.status).toBe('unpaid');
    expect(h.lines.some((l) => l.includes('network_revoke_failed'))).toBe(true);
  });

  it('past_due (dunning) and incomplete keep existing nodes; unpaid and incomplete_expired revoke them', async () => {
    let t = 1_800_000_000_000;
    const h = await harness({ now: () => (t += 1000) });
    const ids = [h.hs.addNode(expectedName(USER)), h.hs.addNode(expectedName(USER))];
    for (const status of ['past_due', 'incomplete']) {
      h.billing.setSub('sub_1', status);
      expect((await h.sendEvent('customer.subscription.updated', { id: 'sub_1', metadata: { clerk_user_id: USER } })).status).toBe(200);
    }
    expect(h.hs.nodes.map((n) => n.id)).toEqual(ids);
    expect(h.hs.calls).toHaveLength(0);
    // past_due still cannot mint NEW keys.
    expect((await h.preauth(await h.clerk.mint())).status).toBe(402);

    h.billing.setSub('sub_1', 'unpaid');
    await h.sendEvent('customer.subscription.updated', { id: 'sub_1', metadata: { clerk_user_id: USER } });
    expect(h.hs.nodes).toHaveLength(0);

    const x = await harness({ now: () => (t += 1000) });
    x.hs.addNode(expectedName(USER));
    x.billing.setSub('sub_1', 'incomplete_expired');
    await x.sendEvent('customer.subscription.updated', { id: 'sub_1', metadata: { clerk_user_id: USER } });
    expect((await x.store.get(USER))?.status).toBe('canceled');
    expect(x.hs.nodes).toHaveLength(0);
  });

  it('no Headscale user -> no node calls; network disabled -> no-op', async () => {
    const h = await harness();
    h.billing.setSub('sub_1', 'canceled');
    expect((await h.sendEvent('customer.subscription.deleted', { id: 'sub_1', metadata: { clerk_user_id: USER } })).status).toBe(200);
    expect(h.hs.calls.map((c) => c.method + ' ' + c.path.split('?')[0])).toEqual(['GET /api/v1/user']);

    const d = await harness({ network: false });
    d.billing.setSub('sub_1', 'canceled');
    expect((await d.sendEvent('customer.subscription.deleted', { id: 'sub_1', metadata: { clerk_user_id: USER } })).status).toBe(200);
    expect(await revokeUserNodes(null, USER, { info() {}, warn() {}, error() {} })).toBe(0);
  });

  it('a single failing node delete does not stop the others', async () => {
    const h = await harness();
    const a = h.hs.addNode(expectedName(USER));
    const b = h.hs.addNode(expectedName(USER));
    h.hs.failStatus[`DELETE /api/v1/node/${a}`] = 500;
    const net = { client: createHeadscaleClient({ baseUrl: HS_URL, apiKey: HS_API_KEY, fetch: h.hs.fetch as typeof fetch }), loginServer: LOGIN_SERVER, preauthTtlSeconds: 600 };
    expect(await revokeUserNodes(net, USER, { info() {}, warn() {}, error() {} })).toBe(1);
    expect(h.hs.nodes.map((n) => n.id)).toEqual([a]);
    expect(b).not.toBe(a);
  });
});

describe('createHeadscaleClient', () => {
  it('maps timeouts/network/HTTP errors to HeadscaleError without upstream bodies', async () => {
    const timeoutFetch = (async () => {
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      throw e;
    }) as unknown as typeof fetch;
    const c1 = createHeadscaleClient({ baseUrl: HS_URL, apiKey: HS_API_KEY, fetch: timeoutFetch });
    await expect(c1.findUserByName('u-x')).rejects.toMatchObject({ kind: 'timeout' });

    const httpFetch = (async () => new Response('secret upstream body', { status: 503 })) as unknown as typeof fetch;
    const c2 = createHeadscaleClient({ baseUrl: HS_URL, apiKey: HS_API_KEY, fetch: httpFetch });
    const err = await c2.createUser('u-x').catch((e) => e);
    expect(err).toBeInstanceOf(HeadscaleError);
    expect(err.status).toBe(503);
    expect(err.message).not.toContain('secret upstream body');
    expect(err.message).not.toContain(HS_API_KEY);
  });

  it('accepts numeric ids too, and rejects a masked/odd key', async () => {
    const f = (async (input: string | URL | Request) => {
      const p = new URL(String(input)).pathname;
      if (p === '/api/v1/user') return new Response(JSON.stringify({ users: [{ id: 7, name: 'u-a' }] }));
      return new Response(JSON.stringify({ preAuthKey: { key: 'hskey-auth-abcdefghijkl-***' } }));
    }) as unknown as typeof fetch;
    const c = createHeadscaleClient({ baseUrl: `${HS_URL}/`, apiKey: HS_API_KEY, fetch: f });
    expect(await c.findUserByName('u-a')).toEqual({ id: '7', name: 'u-a' });
    await expect(c.createPreAuthKey({ userId: '7', reusable: false, ephemeral: false, expiration: new Date() })).rejects.toMatchObject({
      kind: 'bad_response',
    });
  });
});

describe('config: HEADSCALE_*', () => {
  const base = () => ({
    STRIPE_SECRET_KEY: FAKE_STRIPE_KEY,
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_PRICE_ID_PRO: PRICE_ID,
    CLERK_ISSUER: ISSUER,
    CLERK_JWKS_URL: `${ISSUER}/.well-known/jwks.json`,
    CLERK_AUDIENCE: AUDIENCE,
    LICENSE_SIGNING_KEY_PEM: ed25519Pair().privatePem,
    LICENSE_KEY_ID: KID,
  });

  it('all unset -> null (network disabled)', () => {
    expect(loadConfig(base()).headscale).toBeNull();
  });

  it('parses a full config with defaults and canonical URLs', () => {
    const c = loadConfig({ ...base(), HEADSCALE_URL: `${HS_URL}/`, HEADSCALE_API_KEY: HS_API_KEY, HEADSCALE_PUBLIC_URL: `${LOGIN_SERVER}/` });
    expect(c.headscale).toEqual({ url: HS_URL, apiKey: HS_API_KEY, publicUrl: LOGIN_SERVER, preauthTtlSeconds: 600 });
    expect(loadConfig({ ...base(), HEADSCALE_URL: HS_URL, HEADSCALE_API_KEY: HS_API_KEY, HEADSCALE_PUBLIC_URL: LOGIN_SERVER, PREAUTH_TTL_SECONDS: '300' }).headscale?.preauthTtlSeconds).toBe(300);
  });

  it('rejects partial config, http, placeholders and bad TTL', () => {
    expect(() => loadConfig({ ...base(), HEADSCALE_URL: HS_URL })).toThrow(/HEADSCALE_API_KEY.*required|HEADSCALE_PUBLIC_URL is required/s);
    expect(() => loadConfig({ ...base(), HEADSCALE_URL: 'http://hs.example.com', HEADSCALE_API_KEY: HS_API_KEY, HEADSCALE_PUBLIC_URL: LOGIN_SERVER })).toThrow(/HEADSCALE_URL must be an https/);
    expect(() => loadConfig({ ...base(), HEADSCALE_URL: HS_URL, HEADSCALE_API_KEY: 'REPLACE_ME', HEADSCALE_PUBLIC_URL: LOGIN_SERVER })).toThrow(/placeholder/);
    expect(() => loadConfig({ ...base(), HEADSCALE_URL: HS_URL, HEADSCALE_API_KEY: HS_API_KEY, HEADSCALE_PUBLIC_URL: LOGIN_SERVER, PREAUTH_TTL_SECONDS: '5' })).toThrow(/PREAUTH_TTL_SECONDS/);
    // internal compose service name over http is allowed (F-3); public hostnames are not
    expect(loadConfig({ ...base(), HEADSCALE_URL: 'http://headscale:8080', HEADSCALE_API_KEY: HS_API_KEY, HEADSCALE_PUBLIC_URL: LOGIN_SERVER }).headscale?.url).toBe('http://headscale:8080');
    expect(() => loadConfig({ ...base(), HEADSCALE_URL: 'http://hs.example.com:8080', HEADSCALE_API_KEY: HS_API_KEY, HEADSCALE_PUBLIC_URL: LOGIN_SERVER })).toThrow(/HEADSCALE_URL must be an https/);
    expect(() => loadConfig({ ...base(), HEADSCALE_URL: HS_URL, HEADSCALE_API_KEY: HS_API_KEY, HEADSCALE_PUBLIC_URL: 'http://headscale:8080' })).toThrow(/HEADSCALE_PUBLIC_URL must be an https/);
    // localhost http is allowed for dev
    expect(loadConfig({ ...base(), HEADSCALE_URL: 'http://127.0.0.1:8080', HEADSCALE_API_KEY: HS_API_KEY, HEADSCALE_PUBLIC_URL: 'http://localhost:8080' }).headscale?.url).toBe('http://127.0.0.1:8080');
  });
});

describe('/healthz policy readiness (non-secret)', () => {
  it('reports verified / mismatch / unverifiable / not_configured without calling Headscale per request', async () => {
    const ok = await harness();
    await new Promise((r) => setTimeout(r, 0));
    const before = ok.hs.policyCalls.length;
    expect(await (await ok.app.request('/healthz')).json()).toEqual({ ok: true, policy: 'verified' });
    expect(ok.hs.policyCalls.length).toBe(before);
    const bad = await harness({ setup: (hs) => (hs.policy = '{}') });
    await new Promise((r) => setTimeout(r, 0));
    expect(await (await bad.app.request('/healthz')).json()).toEqual({ ok: true, policy: 'mismatch' });
    const down = await harness({ setup: (hs) => (hs.policyDown = true) });
    await new Promise((r) => setTimeout(r, 0));
    expect(await (await down.app.request('/healthz')).json()).toEqual({ ok: true, policy: 'unverifiable' });
    const none = await harness({ network: false });
    expect(await (await none.app.request('/healthz')).json()).toEqual({ ok: true, policy: 'not_configured' });
  });
});

describe('TEMPORARY smoke-test routes (SMOKE_TEST=1)', () => {
  const TOKEN = 'a'.repeat(64);
  const auth = { authorization: `Bearer ${TOKEN}` };
  const smokeHarness = (extra: { until?: number | null; now?: () => number } = {}) => {
    const smoke: SmokeConfig = { stateDir: join(mkdtempSync(join(tmpdir(), 'ab-smoke-')), 'smoke'), until: extra.until ?? null };
    return harness({ smoke, adminToken: TOKEN, now: extra.now }).then((h) => ({ ...h, smoke }));
  };

  it('are not registered without SMOKE_TEST, without Headscale, or without the admin token', async () => {
    for (const h of [await harness({ adminToken: TOKEN }), await harness({ network: false, adminToken: TOKEN, smoke: { stateDir: '/nonexistent', until: null } }), await harness({ smoke: { stateDir: '/nonexistent', until: null } })]) {
      expect((await h.app.request('/v1/admin/smoke/keys', { method: 'POST', headers: auth })).status).toBe(404);
    }
  });

  it('require the admin bearer token', async () => {
    const h = await smokeHarness();
    expect((await h.app.request('/v1/admin/smoke/keys', { method: 'POST' })).status).toBe(401);
    expect((await h.app.request('/v1/admin/smoke/keys', { method: 'POST', headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    expect(h.hs.calls).toHaveLength(0);
  });

  it('issue 2 single-use non-ephemeral 10-min keys for a throwaway user; never logged; capped at 3 calls', async () => {
    const h = await smokeHarness();
    const r = await h.app.request('/v1/admin/smoke/keys', { method: 'POST', headers: auth });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = (await r.json()) as { user: string; login_server: string; auth_keys: string[]; expires_at: number };
    expect(body.user).toMatch(/^smoke-[0-9a-f]{8}$/);
    expect(body.login_server).toBe(LOGIN_SERVER);
    expect(body.auth_keys).toHaveLength(2);
    expect(new Set(body.auth_keys).size).toBe(2);
    const keyCalls = h.hs.calls.filter((c) => c.path === '/api/v1/preauthkey');
    expect(keyCalls.map((c) => [c.body.reusable, c.body.ephemeral])).toEqual([[false, false], [false, false]]);
    expect(Date.parse(keyCalls[0]!.body.expiration) / 1000 - 1_800_000_000).toBe(600);
    for (const k of body.auth_keys) expect(h.lines.join('\n')).not.toContain(k);
    expect((await h.app.request('/v1/admin/smoke/keys', { method: 'POST', headers: auth })).status).toBe(200);
    expect((await h.app.request('/v1/admin/smoke/keys', { method: 'POST', headers: auth })).status).toBe(200);
    expect((await h.app.request('/v1/admin/smoke/keys', { method: 'POST', headers: auth })).status).toBe(429);
  });

  it('cleanup deletes only smoke-* users and their nodes, then disables the routes for good', async () => {
    const h = await smokeHarness();
    const { user } = (await (await h.app.request('/v1/admin/smoke/keys', { method: 'POST', headers: auth })).json()) as { user: string };
    h.hs.addNode(user);
    h.hs.addNode(user);
    const customer = h.hs.addNode(expectedName(USER));
    const r = await h.app.request('/v1/admin/smoke/cleanup', { method: 'POST', headers: auth });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ removed_users: 1, removed_nodes: 2, disabled: true });
    expect(h.hs.users.map((u) => u.name)).toEqual([expectedName(USER)]);
    expect(h.hs.nodes.map((n) => n.id)).toEqual([customer]);
    expect(existsSync(join(h.smoke.stateDir, 'disabled'))).toBe(true);
    for (const path of ['/v1/admin/smoke/keys', '/v1/admin/smoke/cleanup']) {
      expect((await h.app.request(path, { method: 'POST', headers: auth })).status, path).toBe(404);
    }
  });

  it('are 404 after SMOKE_TEST_UNTIL', async () => {
    const h = await smokeHarness({ until: 1_800_000_000 - 1 });
    expect((await h.app.request('/v1/admin/smoke/keys', { method: 'POST', headers: auth })).status).toBe(404);
  });

  it('config: SMOKE_TEST=1 needs Headscale and the admin token', () => {
    const base = {
      NODE_ENV: 'test',
      ENFORCE_ENTITLEMENT: 'false',
      LICENSE_KEY_ID: 'k',
      LICENSE_SIGNING_KEY_PEM: ed25519Pair().privatePem,
    };
    expect(() => loadConfig({ ...base, SMOKE_TEST: '1' })).toThrow(/SMOKE_TEST=1 requires HEADSCALE_URL[\s\S]*requires WAITLIST_ADMIN_TOKEN/);
    expect(() => loadConfig({ ...base, SMOKE_TEST: 'yes' })).toThrow(/SMOKE_TEST must be 0 or 1/);
    expect(loadConfig({ ...base, SMOKE_TEST: '0' }).smoke).toBeNull();
    const c = loadConfig({
      ...base,
      SMOKE_TEST: '1',
      SMOKE_TEST_UNTIL: '1900000000',
      SMOKE_STATE_DIR: '/var/x',
      WAITLIST_ADMIN_TOKEN: TOKEN,
      HEADSCALE_URL: 'http://headscale:8080',
      HEADSCALE_API_KEY: HS_API_KEY,
      HEADSCALE_PUBLIC_URL: LOGIN_SERVER,
    });
    expect(c.smoke).toEqual({ stateDir: '/var/x', until: 1_900_000_000 });
  });
});
