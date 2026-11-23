import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryLicenseCache, GRACE_RETRY_MS, isCheckoutUrl, LicenseGate, REFRESH_INTERVAL_MS } from '../src/main/license/gate';
import * as publicKeysMod from '../src/main/license/publicKeys';
import { verifyLicenseToken } from '../src/main/license/verify';

const KID = 'test-kid';
const USER = 'user_abc123';
const T0 = 1_800_000_000_000; // ms

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const other = generateKeyPairSync('ed25519');

function mint(o: { sub?: string; status?: string; iat?: number; exp?: number; kid?: string; key?: typeof privateKey } = {}) {
  const iat = o.iat ?? Math.floor(Date.now() / 1000);
  const enc = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url');
  const h = enc({ alg: 'EdDSA', typ: 'airbridge-license+jwt', kid: o.kid ?? KID });
  const p = enc({
    iss: 'airbridge-license',
    aud: 'airbridge-desktop',
    sub: o.sub ?? USER,
    plan: 'airbridge_pro',
    status: o.status ?? 'active',
    iat,
    exp: o.exp ?? iat + 72 * 3600,
  });
  const sig = sign(null, Buffer.from(`${h}.${p}`), o.key ?? privateKey).toString('base64url');
  return `${h}.${p}.${sig}`;
}

type Reply = { status: number; body?: unknown } | 'network';

function harness(opts: { replies?: Reply[]; userId?: string | null; cache?: string | null } = {}) {
  const replies = [...(opts.replies ?? [])];
  let userId = opts.userId === undefined ? USER : opts.userId;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const r = replies.length > 1 ? replies.shift()! : replies[0];
    if (!r || r === 'network') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'content-type': 'application/json' } });
  });
  const onValid = vi.fn();
  const onInvalid = vi.fn();
  const openExternal = vi.fn(async () => {});
  const cache = createMemoryLicenseCache(opts.cache ?? null);
  const getAuthToken = vi.fn(async () => (userId ? 'clerk.jwt.token' : null));
  const gate = new LicenseGate({
    licenseUrl: 'https://license.test.example/',
    getAuthToken,
    getUserId: () => userId,
    isPackaged: true,
    publicKeys: { [KID]: PUB },
    onValid,
    onInvalid,
    cache,
    openExternal,
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { gate, fetchMock, onValid, onInvalid, cache, openExternal, getAuthToken, setUser: (u: string | null) => (userId = u), replies };
}

const ok = (token = mint()) => ({ status: 200, body: { token, status: 'active', exp: 0 } });

describe('LicenseGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('valid server token -> verified locally with the real verify.ts, cached, backend started once', async () => {
    const h = harness({ replies: [ok()] });
    const st = await h.gate.start();
    expect(st).toEqual({ state: 'valid', plan: 'airbridge_pro', exp: T0 / 1000 + 72 * 3600 });
    expect(h.onValid).toHaveBeenCalledTimes(1);
    expect(h.onInvalid).not.toHaveBeenCalled();
    expect(await h.cache.load()).toBeTruthy();
    const [url, init] = h.fetchMock.mock.calls[0]!;
    expect(url).toBe('https://license.test.example/v1/license/verify');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer clerk.jwt.token');
    // second check: no duplicate start
    await h.gate.check();
    expect(h.onValid).toHaveBeenCalledTimes(1);
  });

  it('402 inactive -> backend never started, onInvalid, checkout url remembered', async () => {
    const h = harness({ replies: [{ status: 402, body: { status: 'canceled', checkout_url: 'https://checkout.stripe.com/c/pay/cs_1' } }] });
    const st = await h.gate.start();
    expect(st.state).toBe('inactive');
    expect(h.onValid).not.toHaveBeenCalled();
    expect(h.onInvalid).toHaveBeenCalledWith('inactive');
    h.fetchMock.mockRejectedValue(new TypeError('offline'));
    await h.gate.openCheckout();
    expect(h.openExternal).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_1');
  });

  it('a token signed by an unknown key, for another user, or with inactive status is never accepted', async () => {
    for (const bad of [mint({ key: other.privateKey }), mint({ sub: 'user_someoneelse' }), mint({ status: 'canceled' }), mint({ kid: 'nope' })]) {
      const h = harness({ replies: [ok(bad)] });
      const st = await h.gate.start();
      expect(st.state).not.toMatch(/valid|grace/);
      expect(h.onValid).not.toHaveBeenCalled();
      expect(await h.cache.load()).toBeNull();
      h.gate.dispose();
    }
  });

  it('always verifies with expectedSub = signed-in Clerk user and the configured keys', async () => {
    const verify = vi.fn(verifyLicenseToken);
    const h = harness({ replies: [ok()] });
    const gate = new LicenseGate({
      licenseUrl: 'https://license.test.example',
      getAuthToken: async () => 'x',
      getUserId: () => USER,
      isPackaged: true,
      publicKeys: { [KID]: PUB },
      onValid: () => {},
      onInvalid: () => {},
      fetch: h.fetchMock as unknown as typeof fetch,
      verify,
    });
    await gate.check();
    expect(verify).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ expectedSub: USER, publicKeys: { [KID]: PUB } }));
  });

  it('uses getLicensePublicKeys({isPackaged}) when no override is given', () => {
    const spy = vi.spyOn(publicKeysMod, 'getLicensePublicKeys');
    new LicenseGate({
      licenseUrl: 'https://license.test.example',
      getAuthToken: async () => null,
      getUserId: () => null,
      isPackaged: true,
      onValid: () => {},
      onInvalid: () => {},
    });
    expect(spy).toHaveBeenCalledWith({ isPackaged: true });
  });

  it('no signed-in user -> cached token is NOT honored (sub binding)', async () => {
    const h = harness({ replies: ['network'], userId: null, cache: mint() });
    const st = await h.gate.start();
    expect(st.state).toBe('inactive');
    expect(h.onValid).not.toHaveBeenCalled();
  });

  it('offline with a valid cached token -> grace, backend runs until exp, then stops', async () => {
    const h = harness({ replies: [ok()] });
    await h.gate.start();
    expect(h.onValid).toHaveBeenCalledTimes(1);

    // go offline
    h.fetchMock.mockImplementation(async () => {
      throw new TypeError('offline');
    });
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    expect(h.gate.getStatus().state).toBe('grace');
    expect(h.onInvalid).not.toHaveBeenCalled();

    // still within 72h: grace retries keep it running
    await vi.advanceTimersByTimeAsync(24 * 3600 * 1000);
    expect(h.gate.getStatus().state).toBe('grace');
    expect(h.onInvalid).not.toHaveBeenCalled();

    // past exp -> stop
    await vi.advanceTimersByTimeAsync(48 * 3600 * 1000 + 2000);
    expect(h.gate.getStatus()).toEqual({ state: 'inactive', plan: null, exp: null });
    expect(h.onInvalid).toHaveBeenCalledWith('expired');
    expect(h.onInvalid).toHaveBeenCalledTimes(1);
    expect(await h.cache.load()).toBeNull();
  });

  it('launch offline with cached token -> grace (starts backend); with expired cache -> blocked', async () => {
    const h = harness({ replies: ['network'], cache: mint() });
    expect((await h.gate.start()).state).toBe('grace');
    expect(h.onValid).toHaveBeenCalledTimes(1);

    const old = mint({ iat: T0 / 1000 - 80 * 3600, exp: T0 / 1000 - 8 * 3600 });
    const h2 = harness({ replies: ['network'], cache: old });
    expect((await h2.gate.start()).state).toBe('inactive');
    expect(h2.onValid).not.toHaveBeenCalled();
    expect(h2.onInvalid).toHaveBeenCalledWith('expired');
  });

  it('launch offline with no cache -> unknown, backend not started, retries soon', async () => {
    const h = harness({ replies: ['network'] });
    expect((await h.gate.start()).state).toBe('unknown');
    expect(h.onValid).not.toHaveBeenCalled();
    h.replies.splice(0, h.replies.length, ok());
    await vi.advanceTimersByTimeAsync(GRACE_RETRY_MS);
    expect(h.gate.getStatus().state).toBe('valid');
    expect(h.onValid).toHaveBeenCalledTimes(1);
  });

  it('re-checks every 6h; a subscription that lapses stops the backend', async () => {
    const h = harness({ replies: [ok()] });
    await h.gate.start();
    h.replies.splice(0, h.replies.length, { status: 402, body: { status: 'past_due', checkout_url: null } });
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS - 1000);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    expect(h.gate.getStatus().state).toBe('inactive');
    expect(h.onInvalid).toHaveBeenCalledWith('inactive');
    expect(await h.cache.load()).toBeNull();
  });

  it('server 5xx falls back to cache (grace) rather than killing a paid user', async () => {
    const h = harness({ replies: [ok()] });
    await h.gate.start();
    h.replies.splice(0, h.replies.length, { status: 503 });
    await h.gate.check();
    expect(h.gate.getStatus().state).toBe('grace');
    expect(h.onInvalid).not.toHaveBeenCalled();
  });

  it('401 and sign-out reset stop the backend and clear the cache', async () => {
    const h = harness({ replies: [ok()] });
    await h.gate.start();
    h.replies.splice(0, h.replies.length, { status: 401 });
    await h.gate.check();
    expect(h.gate.getStatus().state).toBe('inactive');
    expect(h.onInvalid).toHaveBeenCalledWith('signed_out');

    const h2 = harness({ replies: [ok()] });
    await h2.gate.start();
    await h2.gate.reset();
    expect(h2.onInvalid).toHaveBeenCalledWith('signed_out');
    expect(await h2.cache.load()).toBeNull();
  });

  it('emits status changes to listeners', async () => {
    const h = harness({ replies: [ok()] });
    const seen: string[] = [];
    h.gate.onChange((s) => seen.push(s.state));
    await h.gate.start();
    await h.gate.reset();
    expect(seen).toEqual(['valid', 'inactive']);
  });

  it('openCheckout only opens Stripe-hosted https URLs', async () => {
    const h = harness({ replies: [{ status: 200, body: { url: 'https://evil.example/phish' } }] });
    await expect(h.gate.openCheckout()).rejects.toThrow(/checkout_unavailable/);
    expect(h.openExternal).not.toHaveBeenCalled();
    const h2 = harness({ replies: [{ status: 200, body: { url: 'https://billing.stripe.com/p/session/x' } }] });
    await h2.gate.openCheckout();
    expect(h2.openExternal).toHaveBeenCalledWith('https://billing.stripe.com/p/session/x');
    expect(isCheckoutUrl('http://checkout.stripe.com/x')).toBe(false);
    expect(isCheckoutUrl('https://checkout.stripe.com.evil.example/x')).toBe(false);
  });

  it('refuses a non-https license URL (except localhost)', () => {
    const base = { getAuthToken: async () => null, getUserId: () => null, isPackaged: true, onValid() {}, onInvalid() {} };
    expect(() => new LicenseGate({ ...base, licenseUrl: 'http://license.example.com' })).toThrow(/https/);
    expect(() => new LicenseGate({ ...base, licenseUrl: 'http://localhost:8787' })).not.toThrow();
  });
});
