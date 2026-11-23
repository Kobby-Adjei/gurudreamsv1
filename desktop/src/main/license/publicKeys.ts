/**
 * License-signing PUBLIC keys trusted by the desktop app (Security-owned).
 *
 * kid -> PEM SPKI Ed25519 public key. Only public keys ever live here.
 *
 * ┌───────────────────────────────────────────────────────────────────────────────────┐
 * │ DEV PLACEHOLDER KEY ("airbridge-dev-2026-11")                                     │
 * │ Generated 2026-11-23 by the Security engineer. The matching PRIVATE key was never │
 * │ written to disk and has been discarded, so this key verifies nothing: it exists   │
 * │ only so the map is never empty and the code path is exercised. It FAILS CLOSED.   │
 * │ For local end-to-end testing generate your own pair (see below) and inject it.    │
 * └───────────────────────────────────────────────────────────────────────────────────┘
 *
 * Injecting the real keys
 * -----------------------
 * Build time (production): set `MAIN_VITE_AIRBRIDGE_LICENSE_PUBKEYS` when running
 * `electron-vite build` (electron-vite statically inlines `import.meta.env.MAIN_VITE_*` into
 * the main bundle). Value is JSON: {"<kid>":"-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"}.
 * Include the current AND the next kid during a key rotation. When build-time keys are
 * present the dev key is NOT included.
 *
 * Run time (development only): `AIRBRIDGE_LICENSE_PUBKEYS` (same JSON) is honoured by
 * `getLicensePublicKeys()` ONLY when the app is not packaged. A packaged app ignores it,
 * otherwise a user could trust their own signing key and mint licenses.
 *
 * Generate a dev pair (keep the private key OUT of the repo):
 *   node -e "const c=require('crypto');const k=c.generateKeyPairSync('ed25519');
 *     console.log(k.publicKey.export({type:'spki',format:'pem'}));
 *     console.error(k.privateKey.export({type:'pkcs8',format:'pem'}))" 2> ~/.airbridge-dev-license.pem
 * then run the license server with LICENSE_SIGNING_KEY_PEM from that file and LICENSE_KEY_ID=<kid>.
 */

export const DEV_LICENSE_KID = 'airbridge-dev-2026-11';

const DEV_LICENSE_PUBLIC_KEY_PEM =
  '-----BEGIN PUBLIC KEY-----\n' +
  'MCowBQYDK2VwAyEAuVFqPfA/gIpPv/1Zaz3aDLE4/TYjMHbFO8m8wPcdnpg=\n' +
  '-----END PUBLIC KEY-----\n';

const MAX_KEYS = 8;
const PEM_SPKI_RE = /^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/;
const KID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Parse a JSON kid->PEM map. Invalid input yields null (callers fall back, never crash).
 * Only well-formed PUBLIC KEY PEMs are accepted; anything containing "PRIVATE" is refused.
 */
export function parsePublicKeyMap(json: string | undefined | null): Record<string, string> | null {
  if (typeof json !== 'string' || json.trim() === '' || json.length > 32_768) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string> = Object.create(null);
  let n = 0;
  for (const [kid, pem] of Object.entries(raw as Record<string, unknown>)) {
    if (!KID_RE.test(kid) || typeof pem !== 'string') return null;
    if (/PRIVATE/i.test(pem) || !PEM_SPKI_RE.test(pem)) return null;
    out[kid] = pem;
    if (++n > MAX_KEYS) return null;
  }
  return n > 0 ? out : null;
}

function readBuildTimeKeys(): string | undefined {
  try {
    // Literal `import.meta.env.MAIN_VITE_...` so electron-vite/vite can statically replace it.
    // @ts-ignore -- ImportMeta.env typing comes from vite; absent in plain tsc configs.
    return import.meta.env.MAIN_VITE_AIRBRIDGE_LICENSE_PUBKEYS as string | undefined;
  } catch {
    return undefined;
  }
}

const BUILD_TIME_KEYS = parsePublicKeyMap(readBuildTimeKeys());

/** True when no real key was injected at build time (only the dev placeholder is trusted). */
export const USING_DEV_LICENSE_KEY = BUILD_TIME_KEYS === null;

/** The keys compiled into this build. Frozen. */
export const LICENSE_PUBLIC_KEYS: Readonly<Record<string, string>> = Object.freeze(
  BUILD_TIME_KEYS ?? { [DEV_LICENSE_KID]: DEV_LICENSE_PUBLIC_KEY_PEM },
);

/**
 * Keys to pass to verifyLicenseToken. In an unpackaged (dev) app, AIRBRIDGE_LICENSE_PUBKEYS
 * in the environment replaces the compiled keys; in a packaged app the environment is ignored.
 */
export function getLicensePublicKeys(opts: {
  isPackaged: boolean;
  env?: Record<string, string | undefined>;
}): Readonly<Record<string, string>> {
  if (!opts.isPackaged) {
    const env = opts.env ?? (typeof process !== 'undefined' ? process.env : {});
    const override = parsePublicKeyMap(env.AIRBRIDGE_LICENSE_PUBKEYS);
    if (override) return Object.freeze({ ...override });
  }
  return LICENSE_PUBLIC_KEYS;
}
