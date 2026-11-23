import { createPrivateKey, type KeyObject } from 'node:crypto';

export interface Config {
  port: number;
  publicBaseUrl: string | null;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  stripePriceIdPro: string;
  clerkIssuer: string;
  clerkJwksUrl: URL;
  clerkAudience: string[];
  licenseSigningKeyPem: string;
  licenseSigningKey: KeyObject;
  licenseKeyId: string;
  licenseTtlSeconds: number;
  databaseUrl: string | null;
  trustProxy: boolean;
  trustProxyHops: number;
  production: boolean;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(
      `Invalid license-server configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}\n` +
        'See license-server/.env.example and README.md.',
    );
    this.name = 'ConfigError';
  }
}

const DEFAULT_TTL = 259_200; // 72h
const MIN_TTL = 300;
const MAX_TTL = 30 * 24 * 3600;

function isPlaceholder(v: string): boolean {
  return /REPLACE_ME/i.test(v);
}

/** Accept PEMs stored on a single line with literal "\n" escapes (common in PaaS env UIs). */
export function normalizePem(raw: string): string {
  let pem = raw.trim();
  if ((pem.startsWith('"') && pem.endsWith('"')) || (pem.startsWith("'") && pem.endsWith("'"))) {
    pem = pem.slice(1, -1);
  }
  return pem.replace(/\\n/g, '\n');
}

function httpsUrl(name: string, v: string | undefined, problems: string[], allowHttpLocal = true): URL | null {
  if (!v) {
    problems.push(`${name} is required`);
    return null;
  }
  try {
    const u = new URL(v);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(allowHttpLocal && local && u.protocol === 'http:')) {
      problems.push(`${name} must be an https:// URL`);
      return null;
    }
    return u;
  } catch {
    problems.push(`${name} is not a valid URL`);
    return null;
  }
}

/** Validate environment at boot; throws ConfigError listing every problem at once. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const production = env.NODE_ENV === 'production';

  const req = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) {
      problems.push(`${name} is required`);
      return '';
    }
    if (isPlaceholder(v)) problems.push(`${name} still contains a REPLACE_ME placeholder`);
    return v;
  };

  const stripeSecretKey = req('STRIPE_SECRET_KEY');
  if (stripeSecretKey && !/^(sk|rk)_(live|test)_/.test(stripeSecretKey) && !isPlaceholder(stripeSecretKey)) {
    problems.push('STRIPE_SECRET_KEY must be a Stripe secret or restricted key');
  }
  const stripeWebhookSecret = req('STRIPE_WEBHOOK_SECRET');
  if (stripeWebhookSecret && !stripeWebhookSecret.startsWith('whsec_') && !isPlaceholder(stripeWebhookSecret)) {
    problems.push('STRIPE_WEBHOOK_SECRET must start with whsec_');
  }
  const stripePriceIdPro = req('STRIPE_PRICE_ID_PRO');
  if (stripePriceIdPro && !stripePriceIdPro.startsWith('price_') && !isPlaceholder(stripePriceIdPro)) {
    problems.push('STRIPE_PRICE_ID_PRO must be a Stripe price id (price_...)');
  }

  const issuerUrl = httpsUrl('CLERK_ISSUER', env.CLERK_ISSUER?.trim(), problems);
  const clerkIssuer = issuerUrl ? env.CLERK_ISSUER!.trim().replace(/\/+$/, '') : '';
  const clerkJwksUrl = httpsUrl('CLERK_JWKS_URL', env.CLERK_JWKS_URL?.trim(), problems);
  const audRaw = req('CLERK_AUDIENCE');
  const clerkAudience = audRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const licenseKeyId = req('LICENSE_KEY_ID');
  if (licenseKeyId && !/^[A-Za-z0-9._-]{1,64}$/.test(licenseKeyId)) {
    problems.push('LICENSE_KEY_ID must match [A-Za-z0-9._-]{1,64}');
  }

  const pemRaw = req('LICENSE_SIGNING_KEY_PEM');
  let licenseSigningKey: KeyObject | null = null;
  let licenseSigningKeyPem = '';
  if (pemRaw && !isPlaceholder(pemRaw)) {
    licenseSigningKeyPem = normalizePem(pemRaw);
    try {
      licenseSigningKey = createPrivateKey({ key: licenseSigningKeyPem, format: 'pem' });
      if (licenseSigningKey.asymmetricKeyType !== 'ed25519') {
        problems.push(`LICENSE_SIGNING_KEY_PEM must be an Ed25519 key (got ${licenseSigningKey.asymmetricKeyType})`);
      }
    } catch {
      problems.push('LICENSE_SIGNING_KEY_PEM is not a valid PKCS8 PEM private key');
    }
  }

  let licenseTtlSeconds = DEFAULT_TTL;
  if (env.LICENSE_TTL_SECONDS?.trim()) {
    const n = Number(env.LICENSE_TTL_SECONDS.trim());
    if (!Number.isInteger(n) || n < MIN_TTL || n > MAX_TTL) {
      problems.push(`LICENSE_TTL_SECONDS must be an integer between ${MIN_TTL} and ${MAX_TTL}`);
    } else {
      licenseTtlSeconds = n;
    }
  }

  let port = 8787;
  if (env.PORT?.trim()) {
    const n = Number(env.PORT.trim());
    if (!Number.isInteger(n) || n < 1 || n > 65535) problems.push('PORT must be 1-65535');
    else port = n;
  }

  const databaseUrl = env.DATABASE_URL?.trim() || null;
  if (databaseUrl && isPlaceholder(databaseUrl)) problems.push('DATABASE_URL still contains a placeholder');
  if (!databaseUrl && production) {
    problems.push('DATABASE_URL is required when NODE_ENV=production (the in-memory store loses subscriptions on restart)');
  }

  let publicBaseUrl: string | null = null;
  if (env.PUBLIC_BASE_URL?.trim()) {
    const u = httpsUrl('PUBLIC_BASE_URL', env.PUBLIC_BASE_URL.trim(), problems);
    if (u) publicBaseUrl = u.origin;
  }

  if (!publicBaseUrl && production) {
    problems.push('PUBLIC_BASE_URL is required when NODE_ENV=production (used for Checkout redirect URLs)');
  }

  let trustProxyHops = 1;
  if (env.TRUST_PROXY_HOPS?.trim()) {
    const n = Number(env.TRUST_PROXY_HOPS.trim());
    if (!Number.isInteger(n) || n < 1 || n > 5) problems.push('TRUST_PROXY_HOPS must be an integer 1-5');
    else trustProxyHops = n;
  }

  if (problems.length > 0 || !licenseSigningKey || !clerkJwksUrl) {
    throw new ConfigError(problems.length ? problems : ['configuration incomplete']);
  }

  return {
    port,
    publicBaseUrl,
    stripeSecretKey,
    stripeWebhookSecret,
    stripePriceIdPro,
    clerkIssuer,
    clerkJwksUrl,
    clerkAudience,
    licenseSigningKeyPem,
    licenseSigningKey,
    licenseKeyId,
    licenseTtlSeconds,
    databaseUrl,
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    trustProxyHops,
    production,
  };
}
