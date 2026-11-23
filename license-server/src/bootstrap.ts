import pg from 'pg';
import { createApp, consoleLogger } from './app.js';
import { createStripeBillingApi, createStripeClient, createWebhookVerifier } from './billing.js';
import { createClerkVerifier } from './clerkAuth.js';
import { loadConfig, type Config } from './config.js';
import { createLicenseSigner } from './licenseToken.js';
import { InMemorySubscriptionStore, PostgresSubscriptionStore, type SubscriptionStore } from './store.js';

/** Build the production app from environment variables (throws ConfigError with every problem listed). */
export function buildFromEnv(env: NodeJS.ProcessEnv = process.env): { app: ReturnType<typeof createApp>; config: Config; store: SubscriptionStore } {
  const config = loadConfig(env);
  const stripe = createStripeClient(config.stripeSecretKey);
  let store: SubscriptionStore;
  if (config.databaseUrl) {
    store = new PostgresSubscriptionStore(new pg.Pool({ connectionString: config.databaseUrl, max: 5 }));
  } else {
    consoleLogger.warn('using_in_memory_store', { hint: 'set DATABASE_URL; subscriptions are lost on restart' });
    store = new InMemorySubscriptionStore();
  }
  const app = createApp({
    store,
    billing: createStripeBillingApi(stripe),
    verifyWebhook: createWebhookVerifier(stripe),
    webhookSecret: config.stripeWebhookSecret,
    clerk: createClerkVerifier({ issuer: config.clerkIssuer, audience: config.clerkAudience, jwksUrl: config.clerkJwksUrl }),
    signer: createLicenseSigner({ privateKey: config.licenseSigningKey, kid: config.licenseKeyId, ttlSeconds: config.licenseTtlSeconds }),
    priceId: config.stripePriceIdPro,
    publicBaseUrl: config.publicBaseUrl,
    trustProxy: config.trustProxy,
    trustProxyHops: config.trustProxyHops,
  });
  return { app, config, store };
}
