/**
 * GitHub Actions OIDC: CI proves who it is with a short-lived JWT signed by GitHub (no shared secret on either side).
 * We accept a token only when it is signed by a key in GitHub's JWKS, has the expected issuer and audience, and its
 * claims say it was minted by THIS repository, on THIS branch, by one of the allowed workflow files.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const GITHUB_OIDC_JWKS_URL = 'https://token.actions.githubusercontent.com/.well-known/jwks';

export interface GithubOidcPolicy {
  /** owner/repo, e.g. Kobby-Adjei/gurudreamsv1 */
  repository: string;
  /** e.g. refs/heads/main */
  ref: string;
  /** Workflow file paths inside the repo, e.g. .github/workflows/desktop-build.yml */
  workflows: string[];
  audience: string;
  /** Default: push and workflow_dispatch. */
  events?: string[];
}

export interface GithubRunClaims {
  sha: string;
  repository: string;
  ref: string;
  workflowRef: string;
  runId: string;
  runNumber: string;
  event: string;
}

export class OidcError extends Error {}

export type GithubOidcVerifier = (authorization: string | undefined, policy: GithubOidcPolicy) => Promise<GithubRunClaims>;

export function createGithubOidcVerifier(opts: { jwks?: JWTVerifyGetKey; jwksUrl?: string; issuer?: string } = {}): GithubOidcVerifier {
  const jwks = opts.jwks ?? createRemoteJWKSet(new URL(opts.jwksUrl ?? GITHUB_OIDC_JWKS_URL), { cooldownDuration: 30_000 });
  const issuer = opts.issuer ?? GITHUB_OIDC_ISSUER;
  return async (authorization, policy) => {
    const m = /^Bearer ([A-Za-z0-9._-]{20,8192})$/.exec(authorization ?? '');
    if (!m) throw new OidcError('missing_token');
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(m[1]!, jwks, {
        issuer,
        audience: policy.audience,
        algorithms: ['RS256'],
        clockTolerance: 30,
        requiredClaims: ['exp', 'iat', 'sub'],
      }));
    } catch (e) {
      throw new OidcError(`invalid_token: ${(e as Error).message}`);
    }
    const str = (k: string) => (typeof payload[k] === 'string' ? (payload[k] as string) : '');
    const claims: GithubRunClaims = {
      sha: str('sha'),
      repository: str('repository'),
      ref: str('ref'),
      workflowRef: str('workflow_ref'),
      runId: str('run_id'),
      runNumber: str('run_number'),
      event: str('event_name'),
    };
    if (claims.repository !== policy.repository) throw new OidcError('wrong_repository');
    if (claims.ref !== policy.ref) throw new OidcError('wrong_ref');
    const allowedWorkflowRefs = policy.workflows.map((w) => `${policy.repository}/${w}@${policy.ref}`);
    if (!allowedWorkflowRefs.includes(claims.workflowRef)) throw new OidcError('wrong_workflow');
    if (!(policy.events ?? ['push', 'workflow_dispatch']).includes(claims.event)) throw new OidcError('wrong_event');
    if (!/^[0-9a-f]{40}$/.test(claims.sha)) throw new OidcError('bad_sha');
    if (!/^[0-9]{1,20}$/.test(claims.runId)) throw new OidcError('bad_run_id');
    return claims;
  };
}
