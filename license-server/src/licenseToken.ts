import type { KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';
import type { SubscriptionStatus } from './store.js';

export const LICENSE_ISS = 'airbridge-license';
export const LICENSE_AUD = 'airbridge-desktop';
export const LICENSE_TYP = 'airbridge-license+jwt';
export const LICENSE_PLAN = 'airbridge_pro';

export interface LicenseSigner {
  sign(input: { sub: string; status: SubscriptionStatus; now?: number }): Promise<{ token: string; exp: number }>;
}

/** Compact JWS, header {alg:"EdDSA", typ:"airbridge-license+jwt", kid} — frozen contract (PHASE2_PLAN.md §2). */
export function createLicenseSigner(opts: { privateKey: KeyObject; kid: string; ttlSeconds: number }): LicenseSigner {
  if (opts.privateKey.asymmetricKeyType !== 'ed25519') throw new Error('license signing key must be Ed25519');
  return {
    async sign({ sub, status, now }) {
      const iat = Math.floor((now ?? Date.now()) / 1000);
      const exp = iat + opts.ttlSeconds;
      const token = await new SignJWT({ plan: LICENSE_PLAN, status })
        .setProtectedHeader({ alg: 'EdDSA', typ: LICENSE_TYP, kid: opts.kid })
        .setIssuer(LICENSE_ISS)
        .setAudience(LICENSE_AUD)
        .setSubject(sub)
        .setIssuedAt(iat)
        .setExpirationTime(exp)
        .sign(opts.privateKey);
      return { token, exp };
    },
  };
}
