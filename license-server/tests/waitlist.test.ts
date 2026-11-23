import { appendFileSync, mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  bearerMatches,
  csvCell,
  JsonlWaitlistStore,
  normalizeEmail,
  parsePrice,
  parseReferrer,
  parseUtm,
  type WaitlistRouteDeps,
} from '../src/waitlist.js';
import { ed25519Pair, makeHarness } from './helpers.js';

const ORIGIN = 'https://license.test.example';
const ADMIN = 'a'.repeat(40);

function tmpPath() {
  return join(mkdtempSync(join(tmpdir(), 'ab-waitlist-')), 'nested', 'waitlist.jsonl');
}

function recordingLogger() {
  const lines: string[] = [];
  const rec = (level: string) => (msg: string, f?: Record<string, unknown>) => lines.push(JSON.stringify({ level, msg, ...f }));
  const logger: Logger = { info: rec('info'), warn: rec('warn'), error: rec('error') };
  return { logger, lines };
}

async function harness(
  opts: { path?: string; adminToken?: string | null; limits?: WaitlistRouteDeps['limits']; now?: () => number; publicBaseUrl?: string | null } = {},
) {
  const path = opts.path ?? tmpPath();
  const store = new JsonlWaitlistStore(path);
  const { logger, lines } = recordingLogger();
  let ip = '203.0.113.1';
  const h = await makeHarness({
    now: opts.now,
    publicBaseUrl: opts.publicBaseUrl,
    logger,
    waitlist: {
      store,
      adminToken: opts.adminToken === undefined ? ADMIN : opts.adminToken,
      limits: opts.limits ?? { signupPerIpPerHour: 1000, viewPerIpPerHour: 1000 },
    },
  });
  // Route every request through a configurable client IP (TRUST_PROXY + X-Forwarded-For).
  const req = (p: string, init: RequestInit & { ip?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (headers.get('origin') === '__none__') headers.delete('origin');
    headers.set('x-forwarded-for', init.ip ?? ip);
    return h.app.request(p, { ...init, headers }, { incoming: { socket: { remoteAddress: init.ip ?? ip } } });
  };
  const signup = (body: unknown, headers: Record<string, string> = {}, extra: { ip?: string } = {}) =>
    req('/v1/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      ...extra,
    });
  const view = (body: unknown, headers: Record<string, string> = {}, extra: { ip?: string } = {}) =>
    req('/v1/waitlist/view', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
      body: JSON.stringify(body),
      ...extra,
    });
  const adminGet = (p: string, token: string | null = ADMIN) =>
    req(p, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return {
    path,
    store,
    lines,
    signup,
    view,
    adminGet,
    setIp: (v: string) => {
      ip = v;
    },
    fileLines: () =>
      readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

const valid = { email: '  Ada.Lovelace@Example.COM ', variant: 'bridge', price: 15, utm_source: 'hn', utm_medium: 'post', utm_campaign: 'launch-1' };

describe('waitlist validation helpers', () => {
  it('normalizes and validates emails', () => {
    expect(normalizeEmail('  Foo.Bar+tag@Sub.Example.co ')).toBe('foo.bar+tag@sub.example.co');
    for (const bad of ['', 'a', 'a@b', 'a@b.c', '@example.com', 'a@@example.com', 'a@b@example.com', 'a..b@example.com', '.a@example.com',
      'a@-x.com', 'a@x..com', 'a b@example.com', 'a@example.123', 'a<script>@example.com', 42, null]) {
      expect(normalizeEmail(bad), String(bad)).toBeNull();
    }
    expect(normalizeEmail(`${'a'.repeat(64)}@example.com`)).not.toBeNull();
    expect(normalizeEmail(`${'a'.repeat(65)}@example.com`)).toBeNull();
    const long = `${'a'.repeat(60)}@${Array.from({ length: 4 }, () => 'b'.repeat(60)).join('.')}.com`; // > 254
    expect(long.length).toBeGreaterThan(254);
    expect(normalizeEmail(long)).toBeNull();
  });

  it('parses price, utm and referrer', () => {
    expect(parsePrice(8)).toBe(8);
    expect(parsePrice('15')).toBe(15);
    expect(parsePrice(9)).toBeNull();
    expect(parsePrice('8.0')).toBeNull();
    expect(parseUtm('news_letter.v-2')).toBe('news_letter.v-2');
    expect(parseUtm('a'.repeat(65))).toBeNull();
    expect(parseUtm('<x>')).toBeNull();
    expect(parseUtm('')).toBeNull();
    expect(parseReferrer('https://news.ycombinator.com/item?id=1#x')).toBe('https://news.ycombinator.com');
    expect(parseReferrer('javascript:alert(1)')).toBeNull();
    expect(parseReferrer(`https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.example.com/`)).toBeNull(); // origin > 200
    expect(parseReferrer('not a url')).toBeNull();
  });

  it('bearerMatches is exact', () => {
    expect(bearerMatches(`Bearer ${ADMIN}`, ADMIN)).toBe(true);
    expect(bearerMatches(`Bearer ${ADMIN}x`, ADMIN)).toBe(false);
    expect(bearerMatches(ADMIN, ADMIN)).toBe(false);
    expect(bearerMatches(undefined, ADMIN)).toBe(false);
    expect(bearerMatches('Bearer ', ADMIN)).toBe(false);
  });

  it('csvCell quotes and defuses formulas', () => {
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell(null)).toBe('""');
  });
});

describe('POST /v1/waitlist', () => {
  it('stores a normalized first-touch record without echoing or logging the email', async () => {
    const h = await harness();
    const r = await h.signup({ ...valid, referrer: 'https://news.ycombinator.com/item?id=42' });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ ok: true });
    expect(text.toLowerCase()).not.toContain('ada');
    const lines = h.fileLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      kind: 'signup',
      email: 'ada.lovelace@example.com',
      variant: 'bridge',
      price: 15,
      referrer: 'https://news.ycombinator.com',
      utm_source: 'hn',
      utm_medium: 'post',
      utm_campaign: 'launch-1',
    });
    expect(typeof lines[0]!.ts).toBe('string');
    expect(h.lines.join('\n').toLowerCase()).not.toContain('ada');
    expect(h.lines.join('\n')).toContain('waitlist_signup');
  });

  it('creates the directory 0700 and the file 0600', async () => {
    const h = await harness();
    await h.signup(valid);
    expect(statSync(h.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(h.path, '..')).mode & 0o777).toBe(0o700);
  });

  it('is idempotent per email: keeps the first touch and counts repeats', async () => {
    const h = await harness();
    await h.signup(valid);
    const again = await h.signup({ ...valid, email: 'ada.lovelace@example.com', variant: 'private', price: 8, utm_source: 'x' });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true });
    const lines = h.fileLines();
    expect(lines.map((l) => l.kind)).toEqual(['signup', 'repeat']);
    const s = h.store.signups();
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ variant: 'bridge', price: 15, utm_source: 'hn', repeats: 1 });
    expect(h.store.repeatCount()).toBe(1);
  });

  it('drops invalid optional fields to null instead of rejecting', async () => {
    const h = await harness();
    const r = await h.signup({ email: 'x@example.com', variant: 'cross', price: '8', referrer: 'javascript:alert(1)', utm_source: '<b>', utm_medium: 'a'.repeat(65), utm_campaign: 7 });
    expect(r.status).toBe(200);
    expect(h.fileLines()[0]).toMatchObject({ price: 8, referrer: null, utm_source: null, utm_medium: null, utm_campaign: null });
  });

  it('rejects invalid email / variant / price with 400 and stores nothing', async () => {
    const h = await harness();
    for (const [body, fields] of [
      [{ ...valid, email: 'nope' }, ['email']],
      [{ ...valid, email: `${'a'.repeat(250)}@x.com` }, ['email']],
      [{ ...valid, variant: 'other' }, ['variant']],
      [{ ...valid, price: 9 }, ['price']],
      [{}, ['email', 'variant', 'price']],
    ] as const) {
      const r = await h.signup(body);
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: 'invalid_request', fields });
    }
    expect(h.store.signups()).toHaveLength(0);
    for (const bad of ['not json', '[1]', 'null']) expect((await h.signup(bad)).status).toBe(400);
  });

  it('requires application/json and bounds the body size', async () => {
    const h = await harness();
    expect((await h.signup(valid, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await h.signup(valid, { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(415);
    expect((await h.signup({ ...valid, pad: 'x'.repeat(5000) })).status).toBe(413);
  });

  it('honeypot: answers 200 but stores nothing', async () => {
    const h = await harness();
    const r = await h.signup({ ...valid, company: 'ACME Corp' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(h.store.signups()).toHaveLength(0);
    // An empty honeypot is a normal sign-up.
    expect((await h.signup({ ...valid, company: '' })).status).toBe(200);
    expect(h.store.signups()).toHaveLength(1);
    const stats = (await (await h.adminGet('/v1/waitlist/stats')).json()) as { totals: { honeypot_since_boot: number } };
    expect(stats.totals.honeypot_since_boot).toBe(1);
  });

  it('rejects cross-origin browser POSTs with 403; same-origin and no-Origin clients pass', async () => {
    const h = await harness();
    expect((await h.signup(valid, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await h.signup(valid, { origin: 'null' })).status).toBe(403);
    expect((await h.signup(valid, { origin: `${ORIGIN}.evil.example` })).status).toBe(403);
    expect((await h.signup(valid, { 'sec-fetch-site': 'cross-site', origin: ORIGIN })).status).toBe(403);
    expect((await h.view({ variant: 'cross', price: 8 }, { origin: 'https://evil.example' })).status).toBe(403);
    expect(h.store.signups()).toHaveLength(0);
    expect((await h.signup(valid, { 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    // Non-browser clients (no Origin) are allowed; an empty Origin is still "present and different".
    expect((await h.signup({ ...valid, email: 'b@example.com' }, { origin: '__none__' })).status).toBe(200);
    expect((await h.signup({ ...valid, email: 'c@example.com' }, { origin: '' })).status).toBe(403);
  });

  it('falls back to the request origin when PUBLIC_BASE_URL is unset (local dev)', async () => {
    const h = await harness({ publicBaseUrl: null });
    expect((await h.signup(valid, { origin: 'http://localhost' })).status).toBe(200);
    expect((await h.signup(valid, { origin: ORIGIN })).status).toBe(403);
  });

  it('rate limits 5 per IP per hour (default) and resets after the window', async () => {
    let t = 1_800_000_000_000;
    const h = await harness({ limits: {}, now: () => t });
    for (let i = 0; i < 5; i++) expect((await h.signup({ ...valid, email: `u${i}@example.com` })).status).toBe(200);
    expect((await h.signup({ ...valid, email: 'u5@example.com' })).status).toBe(429);
    // Another IP is unaffected.
    expect((await h.signup({ ...valid, email: 'u6@example.com' }, {}, { ip: '198.51.100.7' })).status).toBe(200);
    t += 3_600_000;
    expect((await h.signup({ ...valid, email: 'u5@example.com' })).status).toBe(200);
    expect(h.store.signups()).toHaveLength(7);
  });

  it('enforces a global daily cap', async () => {
    let t = 1_800_000_000_000;
    const h = await harness({ limits: { signupPerIpPerHour: 1000, signupGlobalPerDay: 3 }, now: () => t });
    for (let i = 0; i < 3; i++) expect((await h.signup({ ...valid, email: `g${i}@example.com` }, {}, { ip: `192.0.2.${i}` })).status).toBe(200);
    expect((await h.signup({ ...valid, email: 'g3@example.com' }, {}, { ip: '192.0.2.99' })).status).toBe(429);
    t += 86_400_000;
    expect((await h.signup({ ...valid, email: 'g3@example.com' }, {}, { ip: '192.0.2.99' })).status).toBe(200);
  });

  it('answers 503 (and logs no email) when storage is unwritable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-waitlist-'));
    writeFileSync(join(dir, 'file'), 'x');
    const h = await harness({ path: join(dir, 'file', 'waitlist.jsonl') }); // parent is a regular file
    const r = await h.signup(valid);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'waitlist_unavailable' });
    expect(h.lines.join('\n')).not.toContain('ada');
  });
});

describe('POST /v1/waitlist/view', () => {
  it('counts views with no PII; accepts text/plain (sendBeacon)', async () => {
    const h = await harness();
    expect((await h.view({ variant: 'private', price: 8 })).status).toBe(200);
    expect((await h.view({ variant: 'private', price: 8 }, { 'content-type': 'text/plain;charset=UTF-8' })).status).toBe(200);
    expect((await h.view({ variant: 'private', price: 99 })).status).toBe(400);
    expect((await h.view({ variant: 'nope', price: 8 })).status).toBe(400);
    const lines = h.fileLines();
    expect(lines).toHaveLength(2);
    expect(Object.keys(lines[0]!).sort()).toEqual(['kind', 'price', 'ts', 'variant']);
  });

  it('is rate limited per IP', async () => {
    const h = await harness({ limits: { viewPerIpPerHour: 2 } });
    expect((await h.view({ variant: 'cross', price: 15 })).status).toBe(200);
    expect((await h.view({ variant: 'cross', price: 15 })).status).toBe(200);
    expect((await h.view({ variant: 'cross', price: 15 })).status).toBe(429);
  });
});

describe('admin: /v1/waitlist/stats and /export', () => {
  it('404 when WAITLIST_ADMIN_TOKEN is unset', async () => {
    const h = await harness({ adminToken: null });
    expect((await h.adminGet('/v1/waitlist/stats')).status).toBe(404);
    expect((await h.adminGet('/v1/waitlist/export')).status).toBe(404);
  });

  it('401 without or with a wrong bearer token', async () => {
    const h = await harness();
    for (const p of ['/v1/waitlist/stats', '/v1/waitlist/export']) {
      expect((await h.adminGet(p, null)).status).toBe(401);
      expect((await h.adminGet(p, 'b'.repeat(40))).status).toBe(401);
      expect((await h.adminGet(p, ADMIN.slice(1))).status).toBe(401);
    }
  });

  it('admin endpoints are rate limited per IP', async () => {
    const h = await harness({ limits: { adminPerIpPerMinute: 2 } });
    await h.adminGet('/v1/waitlist/stats', 'wrong');
    await h.adminGet('/v1/waitlist/stats', 'wrong');
    expect((await h.adminGet('/v1/waitlist/stats')).status).toBe(429);
  });

  it('stats: counts by variant x price with conversion, by utm_source, and no emails', async () => {
    const h = await harness();
    for (let i = 0; i < 4; i++) await h.view({ variant: 'bridge', price: 15 });
    await h.view({ variant: 'private', price: 8 });
    await h.signup({ ...valid, email: 'a@example.com' });
    await h.signup({ ...valid, email: 'b@example.com', utm_source: undefined });
    await h.signup({ ...valid, email: 'a@example.com', variant: 'private', price: 8 }); // repeat
    await h.signup({ email: 'c@example.com', variant: 'current', price: 8, utm_source: 'reddit' });
    const r = await h.adminGet('/v1/waitlist/stats');
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toContain('@');
    const s = JSON.parse(text);
    expect(s.totals).toMatchObject({ views: 5, signups: 3, repeat_submissions: 1, conversion: 0.6 });
    expect(s.by_variant_price).toHaveLength(8);
    expect(s.by_variant_price).toContainEqual({ variant: 'bridge', price: 15, views: 4, signups: 2, conversion: 0.5 });
    expect(s.by_variant_price).toContainEqual({ variant: 'private', price: 8, views: 1, signups: 0, conversion: 0 });
    expect(s.by_variant_price).toContainEqual({ variant: 'current', price: 8, views: 0, signups: 1, conversion: null });
    expect(s.by_utm_source).toEqual({ hn: 1, '(none)': 1, reddit: 1 });
  });

  it('export: CSV of emails + fields, formula-safe', async () => {
    const h = await harness();
    await h.signup({ ...valid, referrer: 'https://x.example/a' });
    await h.signup({ ...valid, email: 'ada.lovelace@example.com' }); // repeat
    await h.signup({ email: '=cmd@example.com', variant: 'cross', price: 8 });
    const r = await h.adminGet('/v1/waitlist/export');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/csv/);
    expect(r.headers.get('content-disposition')).toContain('attachment');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const rows = (await r.text()).trim().split('\r\n');
    expect(rows[0]).toBe('ts,email,variant,price,referrer,utm_source,utm_medium,utm_campaign,repeats');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain('"ada.lovelace@example.com","bridge","15","https://x.example","hn","post","launch-1","1"');
    expect(rows[2]).toContain(`"'=cmd@example.com","cross","8","","","","","0"`);
  });
});

describe('JsonlWaitlistStore persistence', () => {
  it('replays the file on restart and tolerates a torn last line', async () => {
    const path = tmpPath();
    const a = new JsonlWaitlistStore(path);
    a.addSignup({ ts: 't', email: 'a@example.com', variant: 'cross', price: 8, referrer: null, utm_source: 's', utm_medium: null, utm_campaign: null });
    a.addView({ ts: 't', variant: 'cross', price: 8 });
    a.close();
    appendFileSync(path, '{"kind":"signup","email":"torn@exa'); // simulated crash mid-write
    const b = new JsonlWaitlistStore(path);
    expect(b.addSignup({ ts: 't2', email: 'a@example.com', variant: 'bridge', price: 15, referrer: null, utm_source: null, utm_medium: null, utm_campaign: null })).toBe(false);
    expect(b.addSignup({ ts: 't3', email: 'b@example.com', variant: 'bridge', price: 15, referrer: null, utm_source: null, utm_medium: null, utm_campaign: null })).toBe(true);
    expect(b.signups().map((s) => [s.email, s.variant, s.repeats])).toEqual([
      ['a@example.com', 'cross', 1],
      ['b@example.com', 'bridge', 0],
    ]);
    expect(b.viewCounts().get('cross:8')).toBe(1);
    // The torn fragment stays isolated on its own line; every other line parses.
    const raw = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    expect(raw.filter((l) => { try { JSON.parse(l); return false; } catch { return true; } })).toHaveLength(1);
    b.close();
  });

  it('tightens permissions on an existing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-waitlist-'));
    mkdirSync(join(dir, 'w'), { mode: 0o755 });
    const path = join(dir, 'w', 'waitlist.jsonl');
    writeFileSync(path, '', { mode: 0o644 });
    const s = new JsonlWaitlistStore(path);
    s.open();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'w')).mode & 0o777).toBe(0o700);
    s.close();
  });
});

describe('waitlist config', () => {
  const base = {
    NODE_ENV: 'production',
    ENFORCE_ENTITLEMENT: 'false',
    PUBLIC_BASE_URL: 'https://x.up.railway.app',
    LICENSE_SIGNING_KEY_PEM: ed25519Pair().privatePem,
    LICENSE_KEY_ID: 'ab-1',
  };
  it('defaults the path and leaves admin disabled', () => {
    const c = loadConfig(base);
    expect(c.waitlistPath).toBe('/data/waitlist/waitlist.jsonl');
    expect(c.waitlistAdminToken).toBeNull();
  });
  it('validates WAITLIST_PATH and WAITLIST_ADMIN_TOKEN', () => {
    expect(loadConfig({ ...base, WAITLIST_PATH: '/tmp/x.jsonl', WAITLIST_ADMIN_TOKEN: ADMIN }).waitlistAdminToken).toBe(ADMIN);
    expect(() => loadConfig({ ...base, WAITLIST_PATH: 'rel/x.jsonl' })).toThrow(/WAITLIST_PATH/);
    expect(() => loadConfig({ ...base, WAITLIST_ADMIN_TOKEN: 'short' })).toThrow(/WAITLIST_ADMIN_TOKEN/);
    expect(() => loadConfig({ ...base, WAITLIST_ADMIN_TOKEN: 'REPLACE_ME'.padEnd(40, 'x') })).toThrow(/WAITLIST_ADMIN_TOKEN/);
  });
});
