/**
 * AirBridge Pro license token verification (Security-owned).
 *
 * Contract (airbridge/docs/PHASE2_PLAN.md §2 "License token"):
 *   compact JWS, header {alg:"EdDSA", typ:"airbridge-license+jwt", kid}
 *   payload {iss:"airbridge-license", aud:"airbridge-desktop", sub, plan:"airbridge_pro", status, iat, exp}
 *
 *   verifyLicenseToken(token, {publicKeys, expectedSub?, now?, skewSec=60})
 *     -> {ok:true, claims} | {ok:false, reason}
 *
 * Design rules:
 *  - Uses ONLY node:crypto. No JOSE library, so there is no algorithm negotiation:
 *    the only accepted algorithm is Ed25519 (`crypto.verify(null, ...)` on an ed25519 KeyObject).
 *    The `alg` header is checked to be exactly "EdDSA" and is never used to pick an algorithm,
 *    so alg:none / HS256-with-public-key-as-secret / RS256 confusion cannot work.
 *  - Strict parsing: exactly 3 non-empty canonical base64url segments (no padding, no
 *    whitespace, no non-canonical trailing bits), total size capped, header must contain exactly
 *    {alg, typ, kid} (so no jku/jwk/x5u/crit tricks), signature must be 64 bytes.
 *  - Never throws: every failure maps to a reason code. Claims are only returned after the
 *    signature has been verified.
 *  - Reason mapping for cases the frozen contract has no dedicated code for (documented in
 *    docs/PHASE2_SECURITY.md):
 *      oversized / bad base64url / bad JSON / extra header fields / wrong typ / missing claims -> "malformed"
 *      kid not present, or the configured key is not a valid Ed25519 SPKI key          -> "unknown_kid"
 *      not yet valid (nbf or iat in the future beyond skew)                              -> "expired"
 *      plan !== "airbridge_pro", or status not active|trialing                            -> "inactive"
 */
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

export const LICENSE_ISSUER = 'airbridge-license';
export const LICENSE_AUDIENCE = 'airbridge-desktop';
export const LICENSE_TYP = 'airbridge-license+jwt';
export const LICENSE_ALG = 'EdDSA';
export const LICENSE_PLAN = 'airbridge_pro';
export const ACCEPTED_STATUSES: readonly string[] = Object.freeze(['active', 'trialing']);
/** Hard cap on the compact token length (characters). Real tokens are ~400 chars. */
export const MAX_TOKEN_LENGTH = 4096;
export const DEFAULT_SKEW_SEC = 60;
/** Skew is clamped so a caller can't accidentally disable expiry with a huge value. */
export const MAX_SKEW_SEC = 300;

export type LicenseFailureReason =
  | 'malformed'
  | 'unknown_kid'
  | 'bad_alg'
  | 'bad_signature'
  | 'expired'
  | 'wrong_aud'
  | 'wrong_iss'
  | 'wrong_sub'
  | 'inactive';

export interface LicenseClaims {
  iss: string;
  aud: string;
  sub: string;
  plan: string;
  status: string;
  iat: number;
  exp: number;
  nbf?: number;
  /** The kid of the key that verified the token. */
  kid: string;
}

export type VerifyResult =
  | { ok: true; claims: LicenseClaims }
  | { ok: false; reason: LicenseFailureReason };

export interface VerifyOptions {
  /** kid -> PEM-encoded SPKI Ed25519 public key. */
  publicKeys: Record<string, string>;
  /** If set, `sub` must equal this (the signed-in Clerk user id). */
  expectedSub?: string;
  /**
   * Current time. Epoch SECONDS (JWT convention). A Date is accepted; a number > 1e11 is
   * treated as epoch milliseconds (Date.now()) to avoid a silent unit mix-up.
   * Defaults to the system clock.
   */
  now?: number | Date;
  /** Allowed clock skew in seconds (default 60, clamped to [0, 300]). */
  skewSec?: number;
}

const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const ED25519_SIG_BYTES = 64;

function fail(reason: LicenseFailureReason): VerifyResult {
  return { ok: false, reason };
}

/** Strict canonical base64url decode. Returns null on any deviation. */
function b64urlDecode(seg: string): Buffer | null {
  if (seg.length === 0 || !B64URL_RE.test(seg) || seg.length % 4 === 1) return null;
  const buf = Buffer.from(seg, 'base64url');
  // Re-encoding must reproduce the input exactly: rejects non-canonical trailing bits
  // (two different strings decoding to the same bytes).
  if (buf.toString('base64url') !== seg) return null;
  return buf;
}

function parseJsonObject(buf: Buffer): Record<string, unknown> | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

const keyCache = new Map<string, KeyObject | null>();

/** Parse a PEM SPKI public key and require Ed25519. Returns null if unusable. */
function loadEd25519Key(pem: unknown): KeyObject | null {
  if (typeof pem !== 'string' || pem.length === 0 || pem.length > 2048) return null;
  if (keyCache.has(pem)) return keyCache.get(pem) ?? null;
  let key: KeyObject | null = null;
  try {
    // A private-key PEM would also yield a public KeyObject here; refuse it explicitly so a
    // private key is never accidentally shipped as "the public key".
    if (!/-----BEGIN PUBLIC KEY-----/.test(pem) || /PRIVATE KEY/.test(pem)) {
      key = null;
    } else {
      const k = createPublicKey({ key: pem, format: 'pem' });
      key = k.type === 'public' && k.asymmetricKeyType === 'ed25519' ? k : null;
    }
  } catch {
    key = null;
  }
  if (keyCache.size > 64) keyCache.clear();
  keyCache.set(pem, key);
  return key;
}

function toNowSeconds(now: number | Date | undefined): number {
  if (now instanceof Date) return Math.floor(now.getTime() / 1000);
  if (typeof now === 'number' && Number.isFinite(now)) {
    return now > 1e11 ? Math.floor(now / 1000) : now;
  }
  return Math.floor(Date.now() / 1000);
}

function isNumericDate(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function isNonEmptyString(v: unknown, max = 256): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

/**
 * Verify an AirBridge license token. Never throws.
 */
export function verifyLicenseToken(token: unknown, opts: VerifyOptions): VerifyResult {
  try {
    return verifyInner(token, opts);
  } catch {
    // Defensive: any unexpected exception is a rejection, never an acceptance.
    return fail('malformed');
  }
}

function verifyInner(token: unknown, opts: VerifyOptions): VerifyResult {
  // ---- 1. Shape -----------------------------------------------------------------------
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return fail('malformed');
  }
  const parts = token.split('.');
  if (parts.length !== 3) return fail('malformed');
  const [h64, p64, s64] = parts as [string, string, string];
  const headerBuf = b64urlDecode(h64);
  const payloadBuf = b64urlDecode(p64);
  const sig = b64urlDecode(s64);
  if (!headerBuf || !payloadBuf || !sig) return fail('malformed');

  // ---- 2. Header ----------------------------------------------------------------------
  const header = parseJsonObject(headerBuf);
  if (!header) return fail('malformed');
  if (header.alg !== LICENSE_ALG) return fail('bad_alg');
  const headerKeys = Object.keys(header).sort();
  if (headerKeys.length !== 3 || headerKeys.join(',') !== 'alg,kid,typ') return fail('malformed');
  if (header.typ !== LICENSE_TYP) return fail('malformed');
  if (!isNonEmptyString(header.kid, 128)) return fail('malformed');
  const kid = header.kid;

  // ---- 3. Key -------------------------------------------------------------------------
  const keys = opts?.publicKeys;
  if (!keys || typeof keys !== 'object' || !Object.prototype.hasOwnProperty.call(keys, kid)) {
    return fail('unknown_kid');
  }
  const key = loadEd25519Key(keys[kid]);
  if (!key || key.asymmetricKeyType !== 'ed25519') return fail('unknown_kid');

  // ---- 4. Signature (Ed25519 only; algorithm=null is required for EdDSA) ---------------
  if (sig.length !== ED25519_SIG_BYTES) return fail('bad_signature');
  const signingInput = Buffer.from(`${h64}.${p64}`, 'ascii');
  let valid = false;
  try {
    valid = cryptoVerify(null, signingInput, key, sig);
  } catch {
    valid = false;
  }
  if (!valid) return fail('bad_signature');

  // ---- 5. Claims (only after the signature is good) -----------------------------------
  const p = parseJsonObject(payloadBuf);
  if (!p) return fail('malformed');
  if (
    !isNonEmptyString(p.iss) ||
    !isNonEmptyString(p.aud) ||
    !isNonEmptyString(p.sub) ||
    !isNonEmptyString(p.plan, 64) ||
    !isNonEmptyString(p.status, 64) ||
    !isNumericDate(p.iat) ||
    !isNumericDate(p.exp) ||
    (p.nbf !== undefined && !isNumericDate(p.nbf))
  ) {
    return fail('malformed');
  }
  if (p.exp <= p.iat) return fail('malformed');

  if (p.iss !== LICENSE_ISSUER) return fail('wrong_iss');
  if (p.aud !== LICENSE_AUDIENCE) return fail('wrong_aud');
  if (opts.expectedSub !== undefined && p.sub !== opts.expectedSub) return fail('wrong_sub');

  const now = toNowSeconds(opts.now);
  const rawSkew = typeof opts.skewSec === 'number' && Number.isFinite(opts.skewSec) ? opts.skewSec : DEFAULT_SKEW_SEC;
  const skew = Math.min(Math.max(rawSkew, 0), MAX_SKEW_SEC);
  // Expired once now >= exp + skew (exp is exclusive per RFC 7519 §4.1.4).
  if (now >= p.exp + skew) return fail('expired');
  // Not yet valid -> reported as "expired" (outside the validity window; contract has no nbf code).
  if (p.iat > now + skew) return fail('expired');
  if (p.nbf !== undefined && p.nbf > now + skew) return fail('expired');

  if (p.plan !== LICENSE_PLAN) return fail('inactive');
  if (!ACCEPTED_STATUSES.includes(p.status)) return fail('inactive');

  const claims: LicenseClaims = {
    iss: p.iss,
    aud: p.aud,
    sub: p.sub,
    plan: p.plan,
    status: p.status,
    iat: p.iat,
    exp: p.exp,
    kid,
  };
  if (p.nbf !== undefined) claims.nbf = p.nbf as number;
  return { ok: true, claims };
}
