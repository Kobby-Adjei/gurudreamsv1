import { existsSync } from 'node:fs';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { createLicenseSigner } from '../src/licenseToken.js';
import { ed25519Pair, makeHarness, PRICE_ID, KID, USER } from './helpers.js';

const b64 = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

async function activate(h: Awaited<ReturnType<typeof makeHarness>>, status = 'active') {
  h.billing.setSub('sub_1', status);
  await h.sendEvent('customer.subscription.updated', { id: 'sub_1', metadata: { clerk_user_id: USER } });
}

describe('POST /v1/license/verify', () => {
  it('401 without a bearer token', async () => {
    const h = await makeHarness();
    const res = await h.verify();
    expect(res.status).toBe(401);
  });

  it('401 for wrong issuer, wrong audience, expired, or foreign-key tokens', async () => {
    const h = await makeHarness();
    await activate(h);
    const other = await generateKeyPair('RS256');
    const bad = [
      await h.clerk.mint({}, { iss: 'https://evil.example' }),
      await h.clerk.mint({}, { aud: 'some-other-client' }),
      await h.clerk.mint({}, { expSec: -120 }),
      await h.clerk.mint({}, { key: other.privateKey }),
      'not.a.jwt',
    ];
    for (const t of bad) expect((await h.verify(t)).status).toBe(401);
  });

  it('active subscription -> 200 signed Ed25519 license with the frozen header/claims', async () => {
    const now = 1_800_000_000_000;
    const h = await makeHarness({ now: () => now });
    await activate(h);
    const res = await h.verify(await h.clerk.mint());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; status: string; exp: number };
    expect(body.status).toBe('active');
    expect(body.exp).toBe(now / 1000 + 259200);

    const [hdr, pl, sig] = body.token.split('.') as [string, string, string];
    expect(b64(hdr)).toEqual({ alg: 'EdDSA', typ: 'airbridge-license+jwt', kid: KID });
    expect(b64(pl)).toEqual({
      iss: 'airbridge-license',
      aud: 'airbridge-desktop',
      sub: USER,
      plan: 'airbridge_pro',
      status: 'active',
      iat: now / 1000,
      exp: now / 1000 + 259200,
    });
    const ok = edVerify(null, Buffer.from(`${hdr}.${pl}`), createPublicKey(h.license.publicPem), Buffer.from(sig, 'base64url'));
    expect(ok).toBe(true);
  });

  it('trialing is entitled too', async () => {
    const h = await makeHarness();
    await activate(h, 'trialing');
    const res = await h.verify(await h.clerk.mint());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('trialing');
  });

  it.each(['past_due', 'canceled', 'unpaid', 'incomplete'])('%s -> 402 with a checkout url', async (status) => {
    const h = await makeHarness();
    await activate(h, status);
    const res = await h.verify(await h.clerk.mint());
    expect(res.status).toBe(402);
    const body = (await res.json()) as { status: string; checkout_url: string };
    expect(body).toEqual({ status, checkout_url: 'https://checkout.stripe.test/c/1' });
    expect(h.billing.checkoutCalls[0]).toMatchObject({
      clerkUserId: USER,
      priceId: PRICE_ID,
      customerId: 'cus_test1',
      successUrl: 'https://license.test.example/checkout/success',
      cancelUrl: 'https://license.test.example/checkout/cancel',
    });
  });

  it('unknown user -> 402 status none', async () => {
    const h = await makeHarness();
    const res = await h.verify(await h.clerk.mint());
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ status: 'none', checkout_url: 'https://checkout.stripe.test/c/1' });
    expect(h.billing.checkoutCalls[0]).toMatchObject({ customerId: null, email: 'dev@example.com' });
  });

  it('is rate limited per client', async () => {
    const h = await makeHarness({ verifyPerMinute: 2 });
    const t = await h.clerk.mint();
    expect((await h.verify(t)).status).toBe(402);
    expect((await h.verify(t)).status).toBe(402);
    expect((await h.verify(t)).status).toBe(429);
  });

  it('rate limit keys on the proxy-appended (rightmost) X-Forwarded-For entry; spoofed left entries do not bypass it', async () => {
    const h = await makeHarness({ verifyPerMinute: 2, trustProxy: true });
    const t = await h.clerk.mint();
    const xff = (spoof: string) => ({ 'x-forwarded-for': `${spoof}, 203.0.113.7` });
    expect((await h.verify(t, xff('1.1.1.1'))).status).toBe(402);
    expect((await h.verify(t, xff('2.2.2.2'))).status).toBe(402);
    expect((await h.verify(t, xff('3.3.3.3'))).status).toBe(429); // rotating the spoofed entry doesn't help
    expect((await h.verify(t, { 'x-forwarded-for': '198.51.100.9' })).status).toBe(402); // a genuinely different client
  });

  it('TRUST_PROXY_HOPS=2 takes the second entry from the right', async () => {
    const h = await makeHarness({ verifyPerMinute: 1, trustProxy: true, trustProxyHops: 2 });
    const t = await h.clerk.mint();
    expect((await h.verify(t, { 'x-forwarded-for': 'spoof1, 203.0.113.7, 10.0.0.1' })).status).toBe(402);
    expect((await h.verify(t, { 'x-forwarded-for': 'spoof2, 203.0.113.7, 10.0.0.2' })).status).toBe(429);
  });

  it('checkout redirect URLs never come from X-Forwarded-Host', async () => {
    const h = await makeHarness({ trustProxy: true });
    await h.verify(await h.clerk.mint(), { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' });
    expect(h.billing.checkoutCalls[0]!.successUrl).toBe('https://license.test.example/checkout/success');
    const dev = await makeHarness({ trustProxy: true, publicBaseUrl: null });
    await dev.verify(await dev.clerk.mint(), { 'x-forwarded-host': 'evil.example' });
    expect(dev.billing.checkoutCalls[0]!.successUrl).not.toMatch(/evil/);
  });

  const verifyTs = join(dirname(fileURLToPath(import.meta.url)), '../../desktop/src/main/license/verify.ts');
  it.skipIf(!existsSync(verifyTs))("token is accepted by the desktop's verifyLicenseToken (Security's verify.ts)", async () => {
    const h = await makeHarness();
    await activate(h);
    const body = (await (await h.verify(await h.clerk.mint())).json()) as { token: string };
    const mod = await import(pathToFileURL(verifyTs).href);
    const r = mod.verifyLicenseToken(body.token, { publicKeys: { [KID]: h.license.publicPem }, expectedSub: USER });
    expect(r.ok).toBe(true);
    const tampered = mod.verifyLicenseToken(body.token, { publicKeys: { other: h.license.publicPem } });
    expect(tampered).toEqual({ ok: false, reason: 'unknown_kid' });
  });
});

describe('POST /v1/billing/checkout', () => {
  it('401 without auth', async () => {
    const h = await makeHarness();
    expect((await h.app.request('/v1/billing/checkout', { method: 'POST' })).status).toBe(401);
  });

  it('returns a Stripe checkout url for a non-subscriber', async () => {
    const h = await makeHarness();
    const res = await h.app.request('/v1/billing/checkout', {
      method: 'POST',
      headers: { authorization: `Bearer ${await h.clerk.mint()}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://checkout.stripe.test/c/1' });
  });

  it('sends an active subscriber to the billing portal instead of a second subscription', async () => {
    const h = await makeHarness();
    await activate(h);
    const res = await h.app.request('/v1/billing/checkout', {
      method: 'POST',
      headers: { authorization: `Bearer ${await h.clerk.mint()}` },
    });
    expect(await res.json()).toEqual({ url: 'https://billing.stripe.test/p/1' });
    expect(h.billing.checkoutCalls).toHaveLength(0);
  });
});

describe('misc routes', () => {
  it('GET /healthz', async () => {
    const h = await makeHarness();
    const res = await h.app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, policy: 'not_configured' });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
  it('GET /v1/license/public-key serves the signing key\'s public half (verifies a real token); 404 when unset', async () => {
    const { jwtVerify } = await import('jose');
    const { buildFromEnv } = await import('../src/bootstrap.js');
    const pair = ed25519Pair();
    const { app, config } = buildFromEnv({
      NODE_ENV: 'test',
      ENFORCE_ENTITLEMENT: 'false',
      LICENSE_KEY_ID: 'ab-test-1',
      LICENSE_SIGNING_KEY_PEM: pair.privatePem,
      WAITLIST_PATH: '/nonexistent-dir-for-test/w.jsonl',
    });
    const res = await app.request('/v1/license/public-key');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kid: string; alg: string; pem: string };
    expect(body).toEqual({ kid: 'ab-test-1', alg: 'EdDSA', pem: pair.publicPem });
    expect(body.pem).not.toContain('PRIVATE');
    const { token } = await createLicenseSigner({ privateKey: config.licenseSigningKey, kid: 'ab-test-1', ttlSeconds: 600 }).sign({ sub: USER, status: 'active' });
    await expect(jwtVerify(token, createPublicKey(body.pem))).resolves.toBeTruthy();
    const h = await makeHarness();
    expect((await h.app.request('/v1/license/public-key')).status).toBe(404);
  });
  it('unknown route 404 json', async () => {
    const h = await makeHarness();
    expect((await h.app.request('/nope')).status).toBe(404);
  });
});
