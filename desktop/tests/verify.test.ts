import { createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_TOKEN_LENGTH,
  verifyLicenseToken,
  type VerifyOptions,
} from '../src/main/license/verify';
import {
  DEV_LICENSE_KID,
  LICENSE_PUBLIC_KEYS,
  getLicensePublicKeys,
  parsePublicKeyMap,
} from '../src/main/license/publicKeys';

// Fresh keys at runtime only; no private key is ever stored in the repo.
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const PUB_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const KID = 'test-kid-1';
const NOW = 1_800_000_000;

const b64u = (v: Buffer | string) => Buffer.from(v).toString('base64url');
const enc = (o: unknown) => b64u(JSON.stringify(o));

function baseClaims(over: Record<string, unknown> = {}) {
  return {
    iss: 'airbridge-license',
    aud: 'airbridge-desktop',
    sub: 'user_123',
    plan: 'airbridge_pro',
    status: 'active',
    iat: NOW - 100,
    exp: NOW + 72 * 3600,
    ...over,
  };
}

function mint(
  claims: Record<string, unknown> = baseClaims(),
  header: Record<string, unknown> = { alg: 'EdDSA', typ: 'airbridge-license+jwt', kid: KID },
  key: KeyObject = privateKey,
): string {
  const input = `${enc(header)}.${enc(claims)}`;
  return `${input}.${b64u(sign(null, Buffer.from(input), key))}`;
}

const opts = (over: Partial<VerifyOptions> = {}): VerifyOptions => ({
  publicKeys: { [KID]: PUB_PEM },
  now: NOW,
  ...over,
});

describe('verifyLicenseToken: happy path', () => {
  it('accepts a valid token and returns claims', () => {
    const r = verifyLicenseToken(mint(), opts({ expectedSub: 'user_123' }));
    expect(r).toEqual({
      ok: true,
      claims: expect.objectContaining({ sub: 'user_123', plan: 'airbridge_pro', status: 'active', kid: KID }),
    });
  });
  it('accepts trialing', () => {
    expect(verifyLicenseToken(mint(baseClaims({ status: 'trialing' })), opts()).ok).toBe(true);
  });
  it('accepts now as Date and as milliseconds', () => {
    expect(verifyLicenseToken(mint(), opts({ now: new Date(NOW * 1000) })).ok).toBe(true);
    expect(verifyLicenseToken(mint(), opts({ now: NOW * 1000 })).ok).toBe(true);
  });
  it('picks the right key among several kids (rotation)', () => {
    const otherPem = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const t = mint(baseClaims(), { alg: 'EdDSA', typ: 'airbridge-license+jwt', kid: 'next' }, other.privateKey);
    expect(verifyLicenseToken(t, opts({ publicKeys: { [KID]: PUB_PEM, next: otherPem } })).ok).toBe(true);
  });
});

describe('verifyLicenseToken: tampering and algorithm confusion', () => {
  it('rejects a tampered payload', () => {
    const [h, , s] = mint().split('.');
    const forged = `${h}.${enc(baseClaims({ sub: 'attacker' }))}.${s}`;
    expect(verifyLicenseToken(forged, opts())).toEqual({ ok: false, reason: 'bad_signature' });
  });
  it('rejects a tampered status (inactive -> active)', () => {
    const real = mint(baseClaims({ status: 'canceled' }));
    const [h, , s] = real.split('.');
    expect(verifyLicenseToken(`${h}.${enc(baseClaims())}.${s}`, opts())).toEqual({ ok: false, reason: 'bad_signature' });
  });
  it('rejects a flipped signature bit', () => {
    const [h, p, s] = mint().split('.');
    const sig = Buffer.from(s!, 'base64url');
    sig[10] ^= 1;
    expect(verifyLicenseToken(`${h}.${p}.${b64u(sig)}`, opts())).toEqual({ ok: false, reason: 'bad_signature' });
  });
  it('rejects a signature from a different key with the same kid', () => {
    expect(verifyLicenseToken(mint(baseClaims(), undefined, other.privateKey), opts())).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });
  it('rejects alg:none (empty and non-empty signature)', () => {
    const h = enc({ alg: 'none', typ: 'airbridge-license+jwt', kid: KID });
    const p = enc(baseClaims());
    expect(verifyLicenseToken(`${h}.${p}.`, opts())).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyLicenseToken(`${h}.${p}.${b64u('x'.repeat(64))}`, opts())).toEqual({ ok: false, reason: 'bad_alg' });
    const hNone = enc({ alg: 'NONE', typ: 'airbridge-license+jwt', kid: KID });
    expect(verifyLicenseToken(`${hNone}.${p}.${b64u('x'.repeat(64))}`, opts())).toEqual({ ok: false, reason: 'bad_alg' });
  });
  it('rejects HS256 signed with the public key PEM as the HMAC secret', () => {
    const h = enc({ alg: 'HS256', typ: 'airbridge-license+jwt', kid: KID });
    const p = enc(baseClaims());
    const mac = createHmac('sha256', PUB_PEM).update(`${h}.${p}`).digest();
    expect(verifyLicenseToken(`${h}.${p}.${b64u(mac)}`, opts())).toEqual({ ok: false, reason: 'bad_alg' });
  });
  it('rejects RS256 / ES256 / Ed25519 alias headers', () => {
    for (const alg of ['RS256', 'ES256', 'Ed25519', 'eddsa']) {
      const t = mint(baseClaims(), { alg, typ: 'airbridge-license+jwt', kid: KID });
      expect(verifyLicenseToken(t, opts())).toEqual({ ok: false, reason: 'bad_alg' });
    }
  });
  it('rejects extra header fields (jwk/jku/crit) and wrong typ', () => {
    const pubJwk = publicKey.export({ format: 'jwk' });
    for (const extra of [{ jwk: pubJwk }, { jku: 'https://evil.example/jwks' }, { crit: ['b64'] }]) {
      const t = mint(baseClaims(), { alg: 'EdDSA', typ: 'airbridge-license+jwt', kid: KID, ...extra });
      expect(verifyLicenseToken(t, opts())).toEqual({ ok: false, reason: 'malformed' });
    }
    expect(verifyLicenseToken(mint(baseClaims(), { alg: 'EdDSA', typ: 'JWT', kid: KID }), opts())).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('verifyLicenseToken: keys', () => {
  it('rejects an unknown kid', () => {
    const t = mint(baseClaims(), { alg: 'EdDSA', typ: 'airbridge-license+jwt', kid: 'nope' });
    expect(verifyLicenseToken(t, opts())).toEqual({ ok: false, reason: 'unknown_kid' });
  });
  it('does not resolve kids through the prototype chain', () => {
    for (const kid of ['__proto__', 'constructor', 'toString']) {
      const t = mint(baseClaims(), { alg: 'EdDSA', typ: 'airbridge-license+jwt', kid });
      expect(verifyLicenseToken(t, opts())).toEqual({ ok: false, reason: 'unknown_kid' });
    }
  });
  it('rejects non-Ed25519 keys configured for the kid', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    for (const pem of [
      rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      ec.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      'not a pem',
    ]) {
      expect(verifyLicenseToken(mint(), opts({ publicKeys: { [KID]: pem } }))).toEqual({
        ok: false,
        reason: 'unknown_kid',
      });
    }
  });
  it('refuses a PRIVATE key PEM configured as a public key', () => {
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(verifyLicenseToken(mint(), opts({ publicKeys: { [KID]: privPem } }))).toEqual({
      ok: false,
      reason: 'unknown_kid',
    });
  });
});

describe('verifyLicenseToken: time', () => {
  const exp = NOW + 1000;
  const t = () => mint(baseClaims({ exp }));
  it('rejects an expired token', () => {
    expect(verifyLicenseToken(mint(baseClaims({ iat: NOW - 7200, exp: NOW - 3600 })), opts())).toEqual({ ok: false, reason: 'expired' });
  });
  it('honours skew exactly at the boundary (default 60 s)', () => {
    expect(verifyLicenseToken(t(), opts({ now: exp + 59 })).ok).toBe(true);
    expect(verifyLicenseToken(t(), opts({ now: exp + 60 }))).toEqual({ ok: false, reason: 'expired' });
  });
  it('skew 0 makes exp exclusive', () => {
    expect(verifyLicenseToken(t(), opts({ now: exp - 1, skewSec: 0 })).ok).toBe(true);
    expect(verifyLicenseToken(t(), opts({ now: exp, skewSec: 0 }))).toEqual({ ok: false, reason: 'expired' });
  });
  it('clamps an absurd skew so expiry cannot be disabled', () => {
    expect(verifyLicenseToken(t(), opts({ now: exp + 10_000, skewSec: 1e9 }))).toEqual({ ok: false, reason: 'expired' });
    expect(verifyLicenseToken(t(), opts({ now: exp + 10, skewSec: -50 }))).toEqual({ ok: false, reason: 'expired' });
  });
  it('rejects a token issued in the future and nbf in the future', () => {
    expect(verifyLicenseToken(mint(baseClaims({ iat: NOW + 600 })), opts())).toEqual({ ok: false, reason: 'expired' });
    expect(verifyLicenseToken(mint(baseClaims({ nbf: NOW + 600 })), opts())).toEqual({ ok: false, reason: 'expired' });
    expect(verifyLicenseToken(mint(baseClaims({ iat: NOW + 30, nbf: NOW + 30 })), opts()).ok).toBe(true);
  });
  it('rejects non-integer / string / missing time claims', () => {
    for (const over of [{ exp: String(NOW + 100) }, { exp: NOW + 0.5 }, { iat: undefined }, { exp: NOW - 200 }]) {
      expect(verifyLicenseToken(mint(baseClaims(over)), opts())).toEqual({ ok: false, reason: 'malformed' });
    }
  });
});

describe('verifyLicenseToken: claims', () => {
  it('wrong aud / iss / sub', () => {
    expect(verifyLicenseToken(mint(baseClaims({ aud: 'other' })), opts())).toEqual({ ok: false, reason: 'wrong_aud' });
    expect(verifyLicenseToken(mint(baseClaims({ aud: ['airbridge-desktop'] })), opts())).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyLicenseToken(mint(baseClaims({ iss: 'evil' })), opts())).toEqual({ ok: false, reason: 'wrong_iss' });
    expect(verifyLicenseToken(mint(), opts({ expectedSub: 'user_999' }))).toEqual({ ok: false, reason: 'wrong_sub' });
  });
  it('inactive statuses', () => {
    for (const status of ['canceled', 'past_due', 'unpaid', 'incomplete', 'ACTIVE', 'paused']) {
      expect(verifyLicenseToken(mint(baseClaims({ status })), opts())).toEqual({ ok: false, reason: 'inactive' });
    }
  });
  it('wrong plan is inactive', () => {
    expect(verifyLicenseToken(mint(baseClaims({ plan: 'airbridge_free' })), opts())).toEqual({
      ok: false,
      reason: 'inactive',
    });
  });
});

describe('verifyLicenseToken: malformed input', () => {
  it('rejects oversized tokens before any crypto', () => {
    const big = mint(baseClaims({ pad: 'a'.repeat(MAX_TOKEN_LENGTH) }));
    expect(big.length).toBeGreaterThan(MAX_TOKEN_LENGTH);
    expect(verifyLicenseToken(big, opts())).toEqual({ ok: false, reason: 'malformed' });
  });
  it('rejects wrong part counts, padding, whitespace, non-canonical base64url', () => {
    const good = mint();
    const [h, p, s] = good.split('.') as [string, string, string];
    const cases: unknown[] = [
      '',
      'a.b',
      `${good}.x`,
      `${h}..${s}`,
      `${h}.${p}.${s}=`,
      `${h}=.${p}.${s}`,
      ` ${good}`,
      `${good}\n`,
      `${h}.${p}.${s.replace(/-/g, '+').replace(/_/g, '/')}x+`,
      `${h}.${p.slice(0, -1)}${p.endsWith('A') ? 'B' : 'A'}.${s}`.length ? `${h}.${p}.${s.slice(0, -1)}` : '',
      null,
      undefined,
      12345,
      { token: good },
    ];
    for (const c of cases) {
      const r = verifyLicenseToken(c, opts());
      expect(r.ok).toBe(false);
    }
  });
  it('rejects non-canonical trailing bits in a segment', () => {
    const [h, p, s] = mint().split('.') as [string, string, string];
    // 64-byte sig -> 86 chars, last char carries 2 meaningful bits; flip an unused low bit.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(s[s.length - 1]!);
    const tweaked = s.slice(0, -1) + alphabet[last ^ 1];
    expect(Buffer.from(tweaked, 'base64url').equals(Buffer.from(s, 'base64url'))).toBe(true);
    expect(verifyLicenseToken(`${h}.${p}.${tweaked}`, opts())).toEqual({ ok: false, reason: 'malformed' });
  });
  it('rejects JSON arrays / non-objects / invalid UTF-8 in header or payload', () => {
    const sig = b64u(Buffer.alloc(64));
    expect(verifyLicenseToken(`${b64u('[1]')}.${enc(baseClaims())}.${sig}`, opts()).ok).toBe(false);
    expect(verifyLicenseToken(`${b64u(Buffer.from([0xff, 0xfe]))}.${enc(baseClaims())}.${sig}`, opts())).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
  it('never throws on hostile options', () => {
    expect(verifyLicenseToken(mint(), { publicKeys: null as never })).toEqual({ ok: false, reason: 'unknown_kid' });
    expect(verifyLicenseToken(mint(), undefined as never).ok).toBe(false);
  });
});

describe('publicKeys', () => {
  it('ships only a labelled dev PUBLIC key by default', () => {
    expect(Object.keys(LICENSE_PUBLIC_KEYS)).toContain(DEV_LICENSE_KID);
    for (const pem of Object.values(LICENSE_PUBLIC_KEYS)) {
      expect(pem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
      expect(pem).not.toMatch(/PRIVATE/);
    }
    expect(Object.isFrozen(LICENSE_PUBLIC_KEYS)).toBe(true);
  });
  it('dev key is a valid Ed25519 key but verifies nothing we can mint', () => {
    const t = mint(baseClaims(), { alg: 'EdDSA', typ: 'airbridge-license+jwt', kid: DEV_LICENSE_KID });
    expect(verifyLicenseToken(t, { publicKeys: { ...LICENSE_PUBLIC_KEYS }, now: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });
  it('env override works unpackaged and is ignored when packaged', () => {
    const env = { AIRBRIDGE_LICENSE_PUBKEYS: JSON.stringify({ [KID]: PUB_PEM }) };
    expect(getLicensePublicKeys({ isPackaged: false, env })).toEqual({ [KID]: PUB_PEM });
    expect(getLicensePublicKeys({ isPackaged: true, env })).toBe(LICENSE_PUBLIC_KEYS);
    const r = verifyLicenseToken(mint(), { publicKeys: { ...getLicensePublicKeys({ isPackaged: false, env }) }, now: NOW });
    expect(r.ok).toBe(true);
  });
  it('parsePublicKeyMap rejects private keys, junk and bad kids', () => {
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(parsePublicKeyMap(JSON.stringify({ k: privPem }))).toBeNull();
    expect(parsePublicKeyMap('not json')).toBeNull();
    expect(parsePublicKeyMap('[]')).toBeNull();
    expect(parsePublicKeyMap(JSON.stringify({ 'bad kid!': PUB_PEM }))).toBeNull();
    expect(parsePublicKeyMap(JSON.stringify({}))).toBeNull();
    expect(parsePublicKeyMap(JSON.stringify({ k: PUB_PEM }))).toEqual({ k: PUB_PEM });
  });
});
