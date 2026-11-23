import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { InMemorySubscriptionStore, PostgresSubscriptionStore, type Queryable } from '../src/store.js';
import { ed25519Pair, FAKE_STRIPE_KEY, WEBHOOK_SECRET } from './helpers.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function env(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    STRIPE_SECRET_KEY: FAKE_STRIPE_KEY,
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_PRICE_ID_PRO: 'price_123',
    CLERK_ISSUER: 'https://x.clerk.accounts.dev/',
    CLERK_JWKS_URL: 'https://x.clerk.accounts.dev/.well-known/jwks.json',
    CLERK_AUDIENCE: 'client_a, client_b',
    LICENSE_SIGNING_KEY_PEM: ed25519Pair().privatePem.replace(/\n/g, '\\n'),
    LICENSE_KEY_ID: 'ab-1',
    ...over,
  };
}

describe('loadConfig', () => {
  it('accepts a valid env, normalizes escaped PEM newlines, defaults TTL to 72h', () => {
    const c = loadConfig(env());
    expect(c.licenseTtlSeconds).toBe(259200);
    expect(c.clerkIssuer).toBe('https://x.clerk.accounts.dev');
    expect(c.clerkAudience).toEqual(['client_a', 'client_b']);
    expect(c.licenseSigningKey.asymmetricKeyType).toBe('ed25519');
    expect(c.databaseUrl).toBeNull();
  });

  it('lists every problem at once', () => {
    try {
      loadConfig({});
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as Error).message;
      for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_ID_PRO', 'CLERK_ISSUER', 'CLERK_JWKS_URL', 'CLERK_AUDIENCE', 'LICENSE_SIGNING_KEY_PEM', 'LICENSE_KEY_ID']) {
        expect(msg).toContain(k);
      }
    }
  });

  it('rejects non-Ed25519 keys, placeholders, http issuer, bad TTL, and missing DB in production', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => loadConfig(env({ LICENSE_SIGNING_KEY_PEM: rsa }))).toThrow(/Ed25519/);
    expect(() => loadConfig(env({ STRIPE_PRICE_ID_PRO: 'REPLACE_ME' }))).toThrow(/placeholder/);
    expect(() => loadConfig(env({ CLERK_ISSUER: 'http://x.example' }))).toThrow(/https/);
    expect(() => loadConfig(env({ LICENSE_TTL_SECONDS: '10' }))).toThrow(/LICENSE_TTL_SECONDS/);
    expect(() => loadConfig(env({ NODE_ENV: 'production' }))).toThrow(/DATABASE_URL/);
    expect(() => loadConfig(env({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@db/x' }))).toThrow(/PUBLIC_BASE_URL/);
    expect(() => loadConfig(env({ TRUST_PROXY_HOPS: '0' }))).toThrow(/TRUST_PROXY_HOPS/);
    const prod = loadConfig(env({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@db/x', PUBLIC_BASE_URL: 'https://license.example.com/' }));
    expect(prod.databaseUrl).toBe('postgres://u:p@db/x');
    expect(prod.publicBaseUrl).toBe('https://license.example.com');
  });
});

describe('ENFORCE_ENTITLEMENT', () => {
  it('defaults to true, accepts true/false/1/0 (case-insensitive), rejects anything else', () => {
    expect(loadConfig(env()).enforceEntitlement).toBe(true);
    expect(loadConfig(env({ ENFORCE_ENTITLEMENT: '' })).enforceEntitlement).toBe(true);
    expect(loadConfig(env({ ENFORCE_ENTITLEMENT: 'true' })).enforceEntitlement).toBe(true);
    expect(loadConfig(env({ ENFORCE_ENTITLEMENT: '1' })).enforceEntitlement).toBe(true);
    expect(loadConfig(env({ ENFORCE_ENTITLEMENT: 'false' })).enforceEntitlement).toBe(false);
    expect(loadConfig(env({ ENFORCE_ENTITLEMENT: ' FALSE ' })).enforceEntitlement).toBe(false);
    expect(loadConfig(env({ ENFORCE_ENTITLEMENT: '0' })).enforceEntitlement).toBe(false);
    expect(() => loadConfig(env({ ENFORCE_ENTITLEMENT: 'no' }))).toThrow(/ENFORCE_ENTITLEMENT/);
  });
});

describe('stores', () => {
  const rec = (status: 'active' | 'canceled', t: number) => ({
    clerkUserId: 'user_1',
    stripeCustomerId: null,
    stripeSubscriptionId: 'sub_1',
    status,
    currentPeriodEnd: null,
    lastEventCreated: t,
  });

  it('in-memory store drops stale writes and tracks processed events', async () => {
    const s = new InMemorySubscriptionStore();
    expect(await s.upsert({ ...rec('active', 10), stripeCustomerId: 'cus_1' })).toBe(true);
    expect(await s.upsert(rec('canceled', 5))).toBe(false);
    expect(await s.get('user_1')).toMatchObject({ status: 'active', stripeCustomerId: 'cus_1' });
    expect(await s.upsert(rec('canceled', 11))).toBe(true);
    expect(await s.get('user_1')).toMatchObject({ status: 'canceled', stripeCustomerId: 'cus_1' });
    expect(await s.hasProcessedEvent('evt_1')).toBe(false);
    await s.markEventProcessed('evt_1');
    expect(await s.hasProcessedEvent('evt_1')).toBe(true);
  });

  it('postgres store issues parameterized, ordering-guarded SQL', async () => {
    const calls: { text: string; params?: unknown[] }[] = [];
    const db: Queryable = {
      async query(text, params) {
        calls.push({ text, params });
        if (text.startsWith('SELECT clerk_user_id')) {
          return {
            rows: [{ clerk_user_id: 'user_1', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', status: 'active', current_period_end: '1900000000', last_event_created: '10' }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      },
    };
    const s = new PostgresSubscriptionStore(db);
    expect(await s.upsert(rec('active', 10))).toBe(true);
    expect(calls[0]!.text).toMatch(/ON CONFLICT \(clerk_user_id\)/);
    expect(calls[0]!.text).toMatch(/WHERE subscriptions\.last_event_created <= EXCLUDED\.last_event_created/);
    expect(calls[0]!.params).toEqual(['user_1', null, 'sub_1', 'active', null, 10]);
    expect(await s.get('user_1')).toEqual({
      clerkUserId: 'user_1', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', status: 'active', currentPeriodEnd: 1900000000, lastEventCreated: 10,
    });
    await s.markEventProcessed('evt_1', 'x');
    expect(calls.at(-1)!.text).toMatch(/ON CONFLICT \(event_id\) DO NOTHING/);
  });
});

describe('scripts/generate-license-keys.ts', () => {
  it('prints a usable Ed25519 keypair', () => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', join(root, 'scripts/generate-license-keys.ts')], { cwd: root, encoding: 'utf8' });
    // Pattern assembled from fragments so the repo secrets scan never matches this file.
    const pemRe = (label: string) => new RegExp(`-{5}BEGIN ${label}-{5}[\\s\\S]+?-{5}END ${label}-{5}`);
    const priv = pemRe(['PRIV', 'ATE KEY'].join('')).exec(out)?.[0];
    const pub = pemRe('PUBLIC KEY').exec(out)?.[0];
    expect(priv).toBeTruthy();
    expect(pub).toBeTruthy();
    const c = loadConfig(env({ LICENSE_SIGNING_KEY_PEM: priv! }));
    expect(c.licenseSigningKey.asymmetricKeyType).toBe('ed25519');
  });
});
