import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildFromEnv } from '../src/bootstrap.js';
import { ed25519Pair } from './helpers.js';

// Preview deployment (PHASE3_PLAN.md §8) before the owner has Stripe/Clerk accounts.
function previewApp(extra: Record<string, string> = {}) {
  return buildFromEnv({
    NODE_ENV: 'production',
    ENFORCE_ENTITLEMENT: 'false',
    PUBLIC_BASE_URL: 'https://airbridge.example.com',
    LICENSE_SIGNING_KEY_PEM: ed25519Pair().privatePem,
    LICENSE_KEY_ID: 'ab-preview',
    WAITLIST_PATH: join(mkdtempSync(join(tmpdir(), 'ab-wl-')), 'w', 'waitlist.jsonl'),
    ...extra,
  }).app;
}

describe('preview mode without Stripe and Clerk', () => {
  it('serves /healthz and answers 503 on billing and auth endpoints', async () => {
    const app = previewApp();
    expect((await app.request('/healthz')).status).toBe(200);
    const hook = await app.request('/v1/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': 't=1,v1=x' }, body: '{}' });
    expect(hook.status).toBe(503);
    expect(await hook.json()).toEqual({ error: 'billing_not_configured' });
    for (const path of ['/v1/license/verify', '/v1/billing/checkout', '/v1/network/preauth-key', '/v1/network/devices/1/remove']) {
      const r = await app.request(path, { method: 'POST', headers: { authorization: 'Bearer a.b.c' } });
      expect(r.status, path).toBe(503);
      expect(await r.json()).toEqual({ error: 'auth_not_configured' });
    }
  });

  it('with Clerk but no Stripe: license/billing answer billing_not_configured', async () => {
    const app = previewApp({
      CLERK_ISSUER: 'https://x.clerk.accounts.dev',
      CLERK_JWKS_URL: 'https://x.clerk.accounts.dev/.well-known/jwks.json',
      CLERK_AUDIENCE: 'client_a',
    });
    for (const path of ['/v1/license/verify', '/v1/billing/checkout']) {
      const r = await app.request(path, { method: 'POST' });
      expect(r.status, path).toBe(503);
      expect(await r.json()).toEqual({ error: 'billing_not_configured' });
    }
    // Network routes run their normal auth (no token -> 401 before any Clerk/JWKS call).
    expect((await app.request('/v1/network/preauth-key', { method: 'POST' })).status).not.toBe(503);
  });
});

describe('Railway landing-page build (no Headscale, no Stripe, no Clerk)', () => {
  it('serves the waitlist from the JSONL file and keeps network endpoints in their 503 state', async () => {
    const app = previewApp();
    const r = await app.request('/v1/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://airbridge.example.com' },
      body: JSON.stringify({ email: 'a@example.com', variant: 'private', price: 8 }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect((await app.request('/v1/waitlist/stats')).status).toBe(404); // no WAITLIST_ADMIN_TOKEN
    const token = 'x'.repeat(48);
    const withAdmin = previewApp({ WAITLIST_ADMIN_TOKEN: token });
    expect((await withAdmin.request('/v1/waitlist/stats', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await app.request('/v1/network/preauth-key', { method: 'POST' })).status).toBe(503);
  });
});
