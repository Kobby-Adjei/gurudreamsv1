import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface AuthenticatedUser {
  sub: string;
  email: string | null;
}

export interface ClerkVerifier {
  /** Verify a `Authorization: Bearer <jwt>` header value. Throws AuthError on any failure. */
  verifyAuthorization(header: string | undefined | null): Promise<AuthenticatedUser>;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

const CLERK_USER_ID = /^user_[A-Za-z0-9]{1,64}$/;

/**
 * Clerk-issued JWTs (OIDC id_token or JWT-format OAuth access token) are verified against the
 * instance JWKS with issuer + audience checks. `jwks` is injectable so tests can use a local key set.
 */
export function createClerkVerifier(opts: {
  issuer: string;
  audience: string | string[];
  jwks?: JWTVerifyGetKey;
  jwksUrl?: URL;
  clockToleranceSec?: number;
}): ClerkVerifier {
  const jwks = opts.jwks ?? (opts.jwksUrl ? createRemoteJWKSet(opts.jwksUrl, { cooldownDuration: 30_000 }) : null);
  if (!jwks) throw new Error('createClerkVerifier: jwks or jwksUrl required');
  return {
    async verifyAuthorization(header) {
      if (!header) throw new AuthError('missing_token');
      const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header.trim());
      if (!m) throw new AuthError('malformed_token');
      try {
        const { payload } = await jwtVerify(m[1]!, jwks, {
          issuer: opts.issuer,
          audience: opts.audience,
          algorithms: ['RS256', 'ES256', 'EdDSA'],
          clockTolerance: opts.clockToleranceSec ?? 30,
          requiredClaims: ['sub', 'exp'],
        });
        const sub = payload.sub ?? '';
        if (!CLERK_USER_ID.test(sub)) throw new AuthError('invalid_subject');
        const email = typeof payload.email === 'string' ? payload.email : null;
        return { sub, email };
      } catch (e) {
        if (e instanceof AuthError) throw e;
        throw new AuthError('invalid_token');
      }
    },
  };
}
