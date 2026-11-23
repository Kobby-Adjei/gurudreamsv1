import { Hono, type Context } from 'hono';
import type Stripe from 'stripe';
import { customerIdOf, mapStripeStatus, periodEndOf, type BillingApi, type WebhookVerifier } from './billing.js';
import { AuthError, type ClerkVerifier } from './clerkAuth.js';
import type { LicenseSigner } from './licenseToken.js';
import { registerNetworkRoutes, revokeUserNodes, type NetworkConfig, type NetworkStatus } from './network.js';
import { registerSmokeRoutes, type SmokeConfig } from './smoke.js';
import { RateLimiter } from './rateLimit.js';
import { isEntitled, type SubscriptionStatus, type SubscriptionStore } from './store.js';
import { registerReleaseRoutes, type ReleaseRouteDeps } from './releases.js';
import { registerWaitlistRoutes, type WaitlistRouteDeps, type WaitlistStore } from './waitlist.js';

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export const consoleLogger: Logger = {
  info: (msg, f) => console.log(JSON.stringify({ level: 'info', msg, ...f })),
  warn: (msg, f) => console.warn(JSON.stringify({ level: 'warn', msg, ...f })),
  error: (msg, f) => console.error(JSON.stringify({ level: 'error', msg, ...f })),
};

export interface AppDeps {
  store: SubscriptionStore;
  billing: BillingApi;
  verifyWebhook: WebhookVerifier;
  webhookSecret: string;
  clerk: ClerkVerifier;
  signer: LicenseSigner;
  priceId: string;
  publicBaseUrl?: string | null;
  trustProxy?: boolean;
  /** Number of trusted proxies appending to X-Forwarded-For (default 1). */
  trustProxyHops?: number;
  /** Override client-IP extraction (default: X-Forwarded-For when trustProxy, else socket address). */
  getClientIp?: (c: Context) => string;
  now?: () => number;
  logger?: Logger;
  rateLimit?: {
    verifyPerMinute?: number;
    checkoutPerMinute?: number;
    networkPerUserPerMinute?: number;
    networkGlobalPerDay?: number;
    networkPerIpPerMinute?: number;
  };
  /** Headscale integration (Phase 3). null/undefined -> /v1/network/* answer 503. */
  network?: NetworkConfig | null;
  /** ENFORCE_ENTITLEMENT (default true). false: /v1/network/preauth-key skips the 402 check (preview mode). */
  enforceEntitlement?: boolean;
  /** Preview mode without Stripe (default true): false -> Stripe-backed endpoints answer 503 billing_not_configured. */
  billingConfigured?: boolean;
  /** Preview mode without Clerk (default true): false -> authenticated endpoints answer 503 auth_not_configured. */
  authConfigured?: boolean;
  /** Landing-page waitlist (/v1/waitlist*). null/undefined -> those routes are not registered (404). */
  waitlist?: { store: WaitlistStore; adminToken: string | null; limits?: WaitlistRouteDeps['limits'] } | null;
  /** Public half of the license signing key, served at GET /v1/license/public-key (null -> 404). */
  licensePublicKey?: { kid: string; pem: string } | null;
  /** TEMPORARY smoke-test routes (SMOKE_TEST=1). Needs `network` and the waitlist admin token; see smoke.ts. */
  smoke?: SmokeConfig | null;
  /** Desktop installers + download counts + CI self-deploy (releases.ts). null -> not registered. */
  releases?: Pick<ReleaseRouteDeps, 'store' | 'counter' | 'verifyOidc' | 'releasePolicy' | 'deployPolicy' | 'deployDir' | 'maxUploadBytes'> | null;
}

const MAX_WEBHOOK_BYTES = 1_000_000;
/** Subscription statuses that remove the customer's Headscale nodes (tech-lead decision: not past_due/incomplete). */
export const REVOKE_NETWORK_STATUSES: ReadonlySet<SubscriptionStatus> = new Set<SubscriptionStatus>(['canceled', 'unpaid']);
const CLERK_USER_ID = /^user_[A-Za-z0-9]{1,64}$/;
const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const log = deps.logger ?? consoleLogger;
  const now = deps.now ?? Date.now;
  const verifyLimiter = new RateLimiter(deps.rateLimit?.verifyPerMinute ?? 30, 60_000, now);
  const checkoutLimiter = new RateLimiter(deps.rateLimit?.checkoutPerMinute ?? 10, 60_000, now);

  const clientIp = (c: Context): string => {
    if (deps.getClientIp) return deps.getClientIp(c);
    if (deps.trustProxy) {
      // Use the entry appended by our own trusted proxy (counted from the RIGHT); everything to
      // its left is client-controlled and must never key the rate limiter.
      const xff = c.req.header('x-forwarded-for');
      if (xff) {
        const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
        const hops = Math.max(1, deps.trustProxyHops ?? 1);
        const ip = parts[parts.length - hops];
        if (ip) return ip;
      }
    }
    const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
    return incoming?.socket?.remoteAddress ?? 'unknown';
  };

  // Checkout redirect base. Production requires PUBLIC_BASE_URL (enforced in loadConfig); the
  // request-URL fallback is for local dev only and never consults X-Forwarded-* headers.
  const baseUrl = (c: Context): string => deps.publicBaseUrl ?? new URL(c.req.url).origin;

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
  });

  app.onError((err, c) => {
    log.error('unhandled_error', { path: c.req.path, err: err.message });
    return c.json({ error: 'internal_error' }, 500);
  });

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  // Non-secret readiness: `policy` is the Headscale policy guard's last verdict (PHASE3_SECURITY H-1/F-1):
  // "verified" means pre-auth keys can be issued. Never triggers a Headscale call.
  let networkStatus: NetworkStatus | null = null;
  app.get('/healthz', (c) => c.json({ ok: true, policy: networkStatus ? networkStatus.policy() : 'not_configured' }));

  // Public half of the license signing key, so a desktop build can embed it (LICENSE_PUBLIC_KEYS, kid -> SPKI PEM).
  app.get('/v1/license/public-key', (c) => {
    const k = deps.licensePublicKey;
    if (!k) return c.json({ error: 'not_found' }, 404);
    return c.json({ kid: k.kid, alg: 'EdDSA', pem: k.pem });
  });

  // Preview mode (ENFORCE_ENTITLEMENT=false) may run without Stripe and/or Clerk configured (config.ts).
  const authOff = deps.authConfigured === false;
  const billingOff = deps.billingConfigured === false;
  const authNotConfigured = (c: Context) => c.json({ error: 'auth_not_configured' }, 503);
  const billingNotConfigured = (c: Context) => c.json({ error: 'billing_not_configured' }, 503);
  if (billingOff) app.post('/v1/stripe/webhook', billingNotConfigured);
  for (const path of ['/v1/license/verify', '/v1/billing/checkout']) {
    if (authOff) app.post(path, authNotConfigured);
    else if (billingOff) app.post(path, billingNotConfigured);
  }
  if (authOff) app.post('/v1/network/*', authNotConfigured);

  // ---------------------------------------------------------------- Stripe webhook
  async function applySubscription(clerkUserId: string | null | undefined, subscriptionId: string, eventId: string) {
    const sub = await deps.billing.retrieveSubscription(subscriptionId);
    const userId = clerkUserId ?? sub.metadata?.clerk_user_id ?? null;
    if (!userId || !CLERK_USER_ID.test(userId)) {
      log.warn('webhook_missing_clerk_user_id', { eventId, subscriptionId });
      return;
    }
    const status = mapStripeStatus(sub.status);
    const existing = await deps.store.get(userId);
    if (
      existing &&
      existing.stripeSubscriptionId &&
      existing.stripeSubscriptionId !== sub.id &&
      isEntitled(existing.status) &&
      !isEntitled(status)
    ) {
      // An old subscription ending must not revoke a newer, active one.
      log.info('webhook_ignored_stale_subscription', { eventId, subscriptionId });
      return;
    }
    // State was fetched live from Stripe, so it is current "as of now"; this ordering stamp lets the
    // store drop anything older that arrives later.
    const applied = await deps.store.upsert({
      clerkUserId: userId,
      stripeCustomerId: customerIdOf(sub.customer),
      stripeSubscriptionId: sub.id,
      status,
      currentPeriodEnd: periodEndOf(sub),
      lastEventCreated: Math.floor(now() / 1000),
    });
    log.info('subscription_updated', { eventId, subscriptionId, status, applied });
    if (applied && REVOKE_NETWORK_STATUSES.has(status)) {
      // Ended (canceled / unpaid / incomplete_expired→canceled): take the customer's devices off the private
      // network (best-effort, never throws). past_due is Stripe's dunning window: no NEW keys (402), but
      // existing devices stay so a card hiccup doesn't wipe them.
      await revokeUserNodes(deps.network ?? null, userId, log);
    }
  }

  async function handleEvent(event: Stripe.Event): Promise<void> {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object as Stripe.Checkout.Session;
      if (s.mode !== 'subscription' || !s.subscription) return;
      const subId = typeof s.subscription === 'string' ? s.subscription : s.subscription.id;
      const clerkUserId = s.metadata?.clerk_user_id ?? s.client_reference_id ?? null;
      await applySubscription(clerkUserId, subId, event.id);
      return;
    }
    if (SUBSCRIPTION_EVENTS.has(event.type)) {
      const sub = event.data.object as Stripe.Subscription;
      await applySubscription(sub.metadata?.clerk_user_id ?? null, sub.id, event.id);
    }
  }

  app.post('/v1/stripe/webhook', async (c) => {
    const signature = c.req.header('stripe-signature');
    if (!signature) return c.json({ error: 'missing_signature' }, 400);
    const declared = Number(c.req.header('content-length') ?? '0');
    if (declared > MAX_WEBHOOK_BYTES) return c.json({ error: 'payload_too_large' }, 413);
    const raw = Buffer.from(await c.req.arrayBuffer());
    if (raw.length > MAX_WEBHOOK_BYTES) return c.json({ error: 'payload_too_large' }, 413);

    let event: Stripe.Event;
    try {
      event = deps.verifyWebhook(raw, signature, deps.webhookSecret);
    } catch {
      log.warn('webhook_bad_signature');
      return c.json({ error: 'invalid_signature' }, 400);
    }

    if (await deps.store.hasProcessedEvent(event.id)) {
      return c.json({ received: true, duplicate: true });
    }
    try {
      await handleEvent(event);
    } catch (e) {
      log.error('webhook_processing_failed', { eventId: event.id, type: event.type, err: (e as Error).message });
      return c.json({ error: 'processing_failed' }, 500); // Stripe will retry
    }
    await deps.store.markEventProcessed(event.id, event.type);
    return c.json({ received: true });
  });

  // ---------------------------------------------------------------- Auth'd endpoints
  async function authenticate(c: Context) {
    try {
      return await deps.clerk.verifyAuthorization(c.req.header('authorization'));
    } catch (e) {
      if (e instanceof AuthError) return null;
      throw e;
    }
  }

  async function checkoutUrl(c: Context, user: { sub: string; email: string | null }, customerId: string | null) {
    const base = baseUrl(c);
    const { url } = await deps.billing.createCheckoutSession({
      clerkUserId: user.sub,
      priceId: deps.priceId,
      customerId,
      email: user.email,
      successUrl: `${base}/checkout/success`,
      cancelUrl: `${base}/checkout/cancel`,
    });
    return url;
  }

  app.post('/v1/license/verify', async (c) => {
    if (!verifyLimiter.allow(clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
    const user = await authenticate(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });

    const rec = await deps.store.get(user.sub);
    if (rec && isEntitled(rec.status)) {
      const { token, exp } = await deps.signer.sign({ sub: user.sub, status: rec.status, now: now() });
      return c.json({ token, status: rec.status, exp });
    }

    let url: string | null = null;
    try {
      url = await checkoutUrl(c, user, rec?.stripeCustomerId ?? null);
    } catch (e) {
      log.error('checkout_create_failed', { err: (e as Error).message });
    }
    return c.json({ status: rec?.status ?? 'none', checkout_url: url }, 402);
  });

  app.post('/v1/billing/checkout', async (c) => {
    if (!checkoutLimiter.allow(clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
    const user = await authenticate(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
    const rec = await deps.store.get(user.sub);
    if (rec && isEntitled(rec.status) && rec.stripeCustomerId) {
      // Already subscribed: send them to the billing portal instead of a second subscription.
      const { url } = await deps.billing.createPortalSession({
        customerId: rec.stripeCustomerId,
        returnUrl: `${baseUrl(c)}/checkout/success`,
      });
      return c.json({ url });
    }
    return c.json({ url: await checkoutUrl(c, user, rec?.stripeCustomerId ?? null) });
  });

  // ---------------------------------------------------------------- Private network (Phase 3)
  networkStatus = registerNetworkRoutes(app, {
    network: deps.network ?? null,
    store: deps.store,
    authenticate,
    clientIp,
    now,
    log,
    enforceEntitlement: deps.enforceEntitlement !== false,
    limits: {
      perUserPerMinute: deps.rateLimit?.networkPerUserPerMinute,
      globalPerDay: deps.rateLimit?.networkGlobalPerDay,
      perIpPerMinute: deps.rateLimit?.networkPerIpPerMinute,
    },
  });

  // ---------------------------------------------------------------- TEMPORARY deployment smoke test
  const smokeAdminToken = deps.waitlist?.adminToken?.trim() || null;
  if (deps.smoke && deps.network && smokeAdminToken) {
    log.warn('SMOKE_TEST_ENABLED', { hint: 'temporary: POST /v1/admin/smoke/cleanup when done (turns it off for good)' });
    registerSmokeRoutes(app, { smoke: deps.smoke, network: deps.network, adminToken: smokeAdminToken, clientIp, now, log });
  }

  // ---------------------------------------------------------------- Landing-page waitlist (demand test)
  if (deps.waitlist) {
    registerWaitlistRoutes(app, {
      store: deps.waitlist.store,
      adminToken: deps.waitlist.adminToken,
      limits: deps.waitlist.limits,
      extraStats: deps.releases ? () => ({ downloads: deps.releases!.counter.stats() }) : undefined,
      expectedOrigin: baseUrl,
      clientIp,
      now,
      log,
    });
  }

  // ---------------------------------------------------------------- Desktop installers (CI-published) + self-deploy
  if (deps.releases) {
    registerReleaseRoutes(app, { ...deps.releases, adminToken: deps.waitlist?.adminToken?.trim() || null, clientIp, now, log });
  }

  // ---------------------------------------------------------------- Checkout landing pages
  const page = (title: string, body: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1d1d1f}` +
    `@media(prefers-color-scheme:dark){body{background:#111;color:#eee}}</style></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
  app.get('/checkout/success', (c) =>
    c.html(page('You are all set', 'Thanks for subscribing to AirBridge Pro. Return to the AirBridge app — it will unlock within a few seconds.')),
  );
  app.get('/checkout/cancel', (c) =>
    c.html(page('Checkout canceled', 'No charge was made. You can close this tab and return to AirBridge.')),
  );

  return app;
}
