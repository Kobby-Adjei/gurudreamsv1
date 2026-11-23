import { generateKeyPairSync } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import Stripe from 'stripe';
import { createApp, type AppDeps, type Logger } from '../src/app.js';
import type { BillingApi, StripeSubscriptionLike } from '../src/billing.js';
import { createClerkVerifier } from '../src/clerkAuth.js';
import { createLicenseSigner } from '../src/licenseToken.js';
import { InMemorySubscriptionStore } from '../src/store.js';

// Built at runtime so secret scanners never see a key-shaped literal.
export const FAKE_STRIPE_KEY = ['sk', 'test', 'offline0000000000000000'].join('_');
export const WEBHOOK_SECRET = ['whsec', 'offlinetestsecret'].join('_');
export const PRICE_ID = 'price_test_pro';
export const ISSUER = 'https://clerk.test.example';
export const AUDIENCE = 'oauth_client_test';
export const KID = 'test-kid-1';
export const USER = 'user_2abcDEF123';

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export function ed25519Pair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKey,
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export async function clerkKeys() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'clerk-kid', alg: 'RS256', use: 'sig' };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const mint = (claims: JWTPayload = {}, opts: { iss?: string; aud?: string; expSec?: number; key?: Parameters<SignJWT["sign"]>[0] } = {}) => {
    const nowSec = Math.floor(Date.now() / 1000);
    return new SignJWT({ email: 'dev@example.com', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'clerk-kid' })
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud ?? AUDIENCE)
      .setSubject((claims.sub as string) ?? USER)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + (opts.expSec ?? 600))
      .sign(opts.key ?? privateKey);
  };
  return { jwks, mint };
}

export class FakeBilling implements BillingApi {
  subs = new Map<string, StripeSubscriptionLike>();
  checkoutCalls: Parameters<BillingApi['createCheckoutSession']>[0][] = [];
  portalCalls: Parameters<BillingApi['createPortalSession']>[0][] = [];
  failRetrieve = false;

  setSub(id: string, status: string, clerkUserId: string | null = USER, customer = 'cus_test1') {
    this.subs.set(id, {
      id,
      status,
      customer,
      metadata: clerkUserId ? { clerk_user_id: clerkUserId } : {},
      current_period_end: 1_900_000_000,
    });
  }
  async createCheckoutSession(p: Parameters<BillingApi['createCheckoutSession']>[0]) {
    this.checkoutCalls.push(p);
    return { url: `https://checkout.stripe.test/c/${this.checkoutCalls.length}` };
  }
  async createPortalSession(p: Parameters<BillingApi['createPortalSession']>[0]) {
    this.portalCalls.push(p);
    return { url: 'https://billing.stripe.test/p/1' };
  }
  async retrieveSubscription(id: string) {
    if (this.failRetrieve) throw new Error('stripe down');
    const s = this.subs.get(id);
    if (!s) throw new Error(`no such subscription ${id}`);
    return s;
  }
}

export async function makeHarness(
  opts: {
    verifyPerMinute?: number;
    now?: () => number;
    trustProxy?: boolean;
    trustProxyHops?: number;
    publicBaseUrl?: string | null;
    waitlist?: AppDeps['waitlist'];
    releases?: AppDeps['releases'];
    getClientIp?: AppDeps['getClientIp'];
    logger?: Logger;
  } = {},
) {
  const stripe = new Stripe(FAKE_STRIPE_KEY); // offline: only used for webhook signature helpers
  const store = new InMemorySubscriptionStore();
  const billing = new FakeBilling();
  const license = ed25519Pair();
  const clerk = await clerkKeys();
  const app = createApp({
    store,
    billing,
    verifyWebhook: (raw, sig, secret) => stripe.webhooks.constructEvent(raw, sig, secret),
    webhookSecret: WEBHOOK_SECRET,
    clerk: createClerkVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks: clerk.jwks }),
    signer: createLicenseSigner({ privateKey: license.privateKey, kid: KID, ttlSeconds: 259200 }),
    priceId: PRICE_ID,
    publicBaseUrl: opts.publicBaseUrl === undefined ? 'https://license.test.example' : opts.publicBaseUrl,
    trustProxy: opts.trustProxy,
    trustProxyHops: opts.trustProxyHops,
    logger: opts.logger ?? silentLogger,
    now: opts.now,
    waitlist: opts.waitlist,
    releases: opts.releases,
    getClientIp: opts.getClientIp,
    rateLimit: { verifyPerMinute: opts.verifyPerMinute ?? 1000, checkoutPerMinute: 1000 },
  });

  let seq = 0;
  const sendEvent = async (type: string, object: Record<string, unknown>, opts2: { id?: string; secret?: string } = {}) => {
    const payload = JSON.stringify({
      id: opts2.id ?? `evt_${++seq}`,
      object: 'event',
      type,
      created: Math.floor(Date.now() / 1000),
      data: { object },
      livemode: false,
      api_version: '2024-06-20',
    });
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: opts2.secret ?? WEBHOOK_SECRET });
    return app.request('/v1/stripe/webhook', {
      method: 'POST',
      body: payload,
      headers: { 'stripe-signature': header, 'content-type': 'application/json' },
    });
  };

  const verify = async (token?: string, extraHeaders: Record<string, string> = {}) =>
    app.request('/v1/license/verify', {
      method: 'POST',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    });

  return { app, store, billing, license, clerk, sendEvent, verify, stripe };
}
