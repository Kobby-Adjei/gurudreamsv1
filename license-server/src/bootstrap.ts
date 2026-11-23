import pg from 'pg';
import { createApp, consoleLogger } from './app.js';
import { createStripeBillingApi, createStripeClient, createWebhookVerifier, type BillingApi, type WebhookVerifier } from './billing.js';
import { AuthError, createClerkVerifier, type ClerkVerifier } from './clerkAuth.js';
import { loadConfig, type Config } from './config.js';
import { createHeadscaleClient } from './headscale.js';
import { createLicenseSigner } from './licenseToken.js';
import { InMemorySubscriptionStore, PostgresSubscriptionStore, type SubscriptionStore } from './store.js';
import { JsonlWaitlistStore } from './waitlist.js';

/** Build the production app from environment variables (throws ConfigError with every problem listed). */
export function buildFromEnv(env: NodeJS.ProcessEnv = process.env): { app: ReturnType<typeof createApp>; config: Config; store: SubscriptionStore } {
  const config = loadConfig(env);
  const stripe = config.billingConfigured ? createStripeClient(config.stripeSecretKey) : null;
  let store: SubscriptionStore;
  if (config.databaseUrl) {
    store = new PostgresSubscriptionStore(new pg.Pool({ connectionString: config.databaseUrl, max: 5 }));
  } else {
    consoleLogger.warn('using_in_memory_store', { hint: 'set DATABASE_URL; subscriptions are lost on restart' });
    store = new InMemorySubscriptionStore();
  }
  const network = config.headscale
    ? {
        client: createHeadscaleClient({ baseUrl: config.headscale.url, apiKey: config.headscale.apiKey }),
        loginServer: config.headscale.publicUrl,
        preauthTtlSeconds: config.headscale.preauthTtlSeconds,
      }
    : null;
  if (!network) {
    consoleLogger.warn('network_disabled', { hint: 'set HEADSCALE_URL, HEADSCALE_API_KEY, HEADSCALE_PUBLIC_URL; /v1/network/* answer 503' });
  }
  if (!config.billingConfigured) {
    consoleLogger.warn('billing_not_configured', { hint: 'preview mode without Stripe: billing endpoints answer 503' });
  }
  if (!config.authConfigured) {
    consoleLogger.warn('auth_not_configured', { hint: 'preview mode without Clerk: authenticated endpoints answer 503' });
  }
  // Unreachable stand-ins: createApp answers 503 before these are used (billingConfigured/authConfigured false).
  const notConfigured = (what: string) => () => {
    throw new Error(`${what} not configured`);
  };
  const billing: BillingApi = stripe
    ? createStripeBillingApi(stripe)
    : { createCheckoutSession: notConfigured('billing'), createPortalSession: notConfigured('billing'), retrieveSubscription: notConfigured('billing') };
  const verifyWebhook: WebhookVerifier = stripe ? createWebhookVerifier(stripe) : notConfigured('billing');
  const clerk: ClerkVerifier = config.clerkJwksUrl
    ? createClerkVerifier({ issuer: config.clerkIssuer, audience: config.clerkAudience, jwksUrl: config.clerkJwksUrl })
    : {
        verifyAuthorization: async () => {
          throw new AuthError('auth_not_configured');
        },
      };
  if (!config.enforceEntitlement) {
    consoleLogger.warn('entitlement_not_enforced', { hint: 'preview mode: any signed-in user can get a network key; set ENFORCE_ENTITLEMENT=true before launch' });
  }
  const waitlistStore = new JsonlWaitlistStore(config.waitlistPath);
  try {
    waitlistStore.open();
  } catch (e) {
    // Non-fatal: the license endpoints keep working; /v1/waitlist answers 503 and retries the open per request.
    consoleLogger.error('waitlist_storage_unavailable', { err: (e as Error).message });
  }
  if (!config.waitlistAdminToken) {
    consoleLogger.warn('waitlist_admin_disabled', { hint: 'set WAITLIST_ADMIN_TOKEN to enable /v1/waitlist/stats and /export' });
  }
  const app = createApp({
    store,
    billing,
    verifyWebhook,
    webhookSecret: config.stripeWebhookSecret,
    clerk,
    signer: createLicenseSigner({ privateKey: config.licenseSigningKey, kid: config.licenseKeyId, ttlSeconds: config.licenseTtlSeconds }),
    priceId: config.stripePriceIdPro,
    publicBaseUrl: config.publicBaseUrl,
    trustProxy: config.trustProxy,
    trustProxyHops: config.trustProxyHops,
    network,
    enforceEntitlement: config.enforceEntitlement,
    billingConfigured: config.billingConfigured,
    authConfigured: config.authConfigured,
    waitlist: { store: waitlistStore, adminToken: config.waitlistAdminToken },
  });
  return { app, config, store };
}
