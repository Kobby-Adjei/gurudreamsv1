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
  /** Phase 3 Headscale integration; null when HEADSCALE_* are all unset (network endpoints answer 503). */
  headscale: HeadscaleConfig | null;
  /**
   * ENFORCE_ENTITLEMENT (default true). false = preview mode (PHASE3_PLAN.md §8): /v1/network/preauth-key
   * skips the 402 subscription check (still Clerk-authenticated and rate-limited). /v1/license/verify is unaffected.
   */
  enforceEntitlement: boolean;
}

export interface HeadscaleConfig {
  /** HEADSCALE_URL: where this server reaches the Headscale REST API (https, or http on localhost). */
  url: string;
  /** HEADSCALE_API_KEY: `headscale apikeys create --expiration 90d`. Secret. */
  apiKey: string;
  /** HEADSCALE_PUBLIC_URL: the login server URL clients enroll against (server_url in config.yaml). */
  publicUrl: string;
  /** PREAUTH_TTL_SECONDS (default 600). */
  preauthTtlSeconds: number;
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

  const headscale = loadHeadscaleConfig(env, problems);

  let enforceEntitlement = true;
  const enforceRaw = env.ENFORCE_ENTITLEMENT?.trim().toLowerCase();
  if (enforceRaw) {
    if (enforceRaw === 'false' || enforceRaw === '0') enforceEntitlement = false;
    else if (enforceRaw !== 'true' && enforceRaw !== '1') problems.push('ENFORCE_ENTITLEMENT must be true or false');
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
    headscale,
    enforceEntitlement,
  };
}

/**
 * HEADSCALE_URL: https anywhere, or plain http to localhost / a single-label private service name on the
 * internal compose network (e.g. http://headscale:8080 — PHASE3_SECURITY.md F-3).
 */
function headscaleApiUrl(raw: string, problems: string[]): URL | null {
  if (!raw) {
    problems.push('HEADSCALE_URL is required');
    return null;
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    problems.push('HEADSCALE_URL is not a valid URL');
    return null;
  }
  const internal = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && internal)) {
    problems.push('HEADSCALE_URL must be an https:// URL (http only for localhost or an internal service name like http://headscale:8080)');
    return null;
  }
  return u;
}

const DEFAULT_PREAUTH_TTL = 600;
const MIN_PREAUTH_TTL = 60;
const MAX_PREAUTH_TTL = 3600;
const HEADSCALE_API_KEY_RE = /^[A-Za-z0-9._-]{20,512}$/;

/**
 * HEADSCALE_URL / HEADSCALE_API_KEY / HEADSCALE_PUBLIC_URL are all-or-nothing. All unset -> null
 * (network disabled, endpoints 503; a warning is logged at boot in production by bootstrap).
 */
function loadHeadscaleConfig(env: NodeJS.ProcessEnv, problems: string[]): HeadscaleConfig | null {
  const rawUrl = env.HEADSCALE_URL?.trim() ?? '';
  const apiKey = env.HEADSCALE_API_KEY?.trim() ?? '';
  const rawPublic = env.HEADSCALE_PUBLIC_URL?.trim() ?? '';
  if (!rawUrl && !apiKey && !rawPublic) return null;

  const before = problems.length;
  const url = headscaleApiUrl(rawUrl, problems);
  const pub = httpsUrl('HEADSCALE_PUBLIC_URL', rawPublic || undefined, problems);
  if (!apiKey) problems.push('HEADSCALE_API_KEY is required when HEADSCALE_URL / HEADSCALE_PUBLIC_URL are set');
  else if (isPlaceholder(apiKey)) problems.push('HEADSCALE_API_KEY still contains a REPLACE_ME placeholder');
  else if (!HEADSCALE_API_KEY_RE.test(apiKey)) problems.push('HEADSCALE_API_KEY does not look like a Headscale API key');
  for (const [name, u] of [['HEADSCALE_URL', url], ['HEADSCALE_PUBLIC_URL', pub]] as const) {
    if (u && (u.username || u.password || u.search || u.hash)) problems.push(`${name} must not contain credentials, a query or a fragment`);
  }

  let preauthTtlSeconds = DEFAULT_PREAUTH_TTL;
  if (env.PREAUTH_TTL_SECONDS?.trim()) {
    const n = Number(env.PREAUTH_TTL_SECONDS.trim());
    if (!Number.isInteger(n) || n < MIN_PREAUTH_TTL || n > MAX_PREAUTH_TTL) {
      problems.push(`PREAUTH_TTL_SECONDS must be an integer between ${MIN_PREAUTH_TTL} and ${MAX_PREAUTH_TTL}`);
    } else {
      preauthTtlSeconds = n;
    }
  }

  if (problems.length > before || !url || !pub) return null;
  return {
    url: (url.origin + url.pathname).replace(/\/+$/, ''),
    apiKey,
    // Clients compare login_server byte-for-byte (network.json); keep a canonical form without trailing slash.
    publicUrl: (pub.origin + pub.pathname).replace(/\/+$/, ''),
    preauthTtlSeconds,
  };
}
