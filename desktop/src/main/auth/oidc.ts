/**
 * Clerk sign-in via OAuth 2.0 authorization code + PKCE (RFC 7636) in the system browser.
 *
 *   signIn() -> shell.openExternal(<issuer>/oauth/authorize?...)  -> user signs in at Clerk
 *            -> Clerk redirects to airbridge://auth/callback?code&state
 *            -> index.ts forwards the deep link to handleCallback(url)
 *            -> state check, code exchange (code_verifier), id_token claim checks
 *
 * Tokens never leave the main process. The refresh token is persisted via TokenStore
 * (safeStorage); access/id tokens live in memory only. The license server is called with the
 * OIDC id_token (a JWT whose aud is the OAuth client id), refreshed when close to expiry.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthState, AuthUser } from '../../shared/types';
import type { TokenStore } from './tokenStore';

export const REDIRECT_URI = 'airbridge://auth/callback';
export const DEFAULT_SCOPES = 'openid profile email offline_access';
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const TOKEN_MIN_TTL_SEC = 60;

export interface OidcConfig {
  issuer: string;
  clientId: string;
  scopes?: string;
}

interface Endpoints {
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
}

interface TokenResponse {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

interface Pending {
  state: string;
  verifier: string;
  nonce: string;
  resolve: () => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AuthFlowError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'AuthFlowError';
  }
}

export function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32)); // 43 chars
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Decode (NOT verify) a JWT payload. id_tokens arrive straight from the token endpoint over TLS (OIDC Core §3.1.3.7). */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface OidcClientDeps {
  config: OidcConfig;
  tokenStore: TokenStore;
  openExternal: (url: string) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
}

export class OidcClient {
  private state: AuthState = { state: 'signed_out' };
  private listeners = new Set<(s: AuthState) => void>();
  private pending: Pending | null = null;
  private endpoints: Endpoints | null = null;
  private refreshToken: string | null = null;
  private idToken: string | null = null;
  private idTokenExp = 0;
  private refreshing: Promise<string | null> | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly issuer: string;

  constructor(private readonly deps: OidcClientDeps) {
    const iss = new URL(deps.config.issuer);
    if (iss.protocol !== 'https:') throw new Error('CLERK_OAUTH_ISSUER must be https');
    if (!deps.config.clientId) throw new Error('CLERK_OAUTH_CLIENT_ID is required');
    this.issuer = deps.config.issuer.replace(/\/+$/, '');
    this.fetchFn = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  // ---------------------------------------------------------------- state

  getState(): AuthState {
    return this.state.user ? { state: this.state.state, user: { ...this.state.user } } : { state: this.state.state };
  }

  /** Clerk user id of the signed-in user (license `sub`). */
  getUserId(): string | null {
    return this.state.state === 'signed_in' ? (this.state.user?.id ?? null) : null;
  }

  onChange(cb: (s: AuthState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private setState(s: AuthState): void {
    this.state = s;
    const snapshot = this.getState();
    for (const l of this.listeners) {
      try {
        l(snapshot);
      } catch {
        /* listener errors never break auth */
      }
    }
  }

  // ---------------------------------------------------------------- discovery

  private async getEndpoints(): Promise<Endpoints> {
    if (this.endpoints) return this.endpoints;
    const fallback: Endpoints = {
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
    };
    try {
      const res = await this.fetchFn(`${this.issuer}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const d = (await res.json()) as Partial<Endpoints> & { issuer?: string };
        const issuerOrigin = new URL(this.issuer).origin;
        const sameOrigin = (u?: string) => !!u && new URL(u).origin === issuerOrigin;
        if (sameOrigin(d.authorization_endpoint) && sameOrigin(d.token_endpoint)) {
          this.endpoints = {
            authorization_endpoint: d.authorization_endpoint!,
            token_endpoint: d.token_endpoint!,
            revocation_endpoint: sameOrigin(d.revocation_endpoint) ? d.revocation_endpoint : undefined,
          };
          return this.endpoints;
        }
      }
    } catch {
      /* fall through to Clerk's well-known paths */
    }
    this.endpoints = fallback;
    return fallback;
  }

  // ---------------------------------------------------------------- sign-in

  /** Opens the system browser; resolves once the deep-link callback completes (or rejects). */
  async signIn(): Promise<void> {
    if (this.pending) {
      this.pending.reject(new AuthFlowError('superseded'));
      clearTimeout(this.pending.timer);
      this.pending = null;
    }
    const ep = await this.getEndpoints();
    const { verifier, challenge } = pkcePair();
    const state = base64url(randomBytes(32));
    const nonce = base64url(randomBytes(16));

    const url = new URL(ep.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.deps.config.clientId,
      redirect_uri: REDIRECT_URI,
      scope: this.deps.config.scopes ?? DEFAULT_SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      nonce,
      prompt: 'login',
    }).toString();

    const prev = this.getState();
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.state === state) {
          this.pending = null;
          this.setState(prev.state === 'signed_in' ? prev : { state: 'signed_out' });
          reject(new AuthFlowError('timeout'));
        }
      }, SIGN_IN_TIMEOUT_MS);
      timer.unref?.();
      this.pending = { state, verifier, nonce, resolve, reject, timer };
    });
    done.catch(() => undefined); // avoid unhandled rejection if caller ignores it
    this.setState({ state: 'signing_in' });
    try {
      await this.deps.openExternal(url.toString());
    } catch (e) {
      this.abortPending(new AuthFlowError('browser_open_failed'));
      this.setState({ state: 'signed_out' });
      throw e;
    }
    return done;
  }

  private abortPending(err: Error): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.reject(err);
    this.pending = null;
  }

  /** True when `url` is our auth callback deep link (index.ts routes it here). */
  static isCallbackUrl(url: string): boolean {
    try {
      const u = new URL(url);
      return u.protocol === 'airbridge:' && u.host === 'auth' && u.pathname === '/callback';
    } catch {
      return false;
    }
  }

  /** Handle `airbridge://auth/callback?...`. Never throws; failures reset to signed_out. */
  async handleCallback(rawUrl: string): Promise<boolean> {
    if (!OidcClient.isCallbackUrl(rawUrl)) return false;
    const p = this.pending;
    if (!p) return false; // unsolicited callback: ignore
    const params = new URL(rawUrl).searchParams;
    const state = params.get('state') ?? '';
    if (!safeEqual(state, p.state)) {
      this.deps.log?.('oidc: state mismatch; ignoring callback');
      return false; // keep waiting for the genuine callback
    }
    clearTimeout(p.timer);
    this.pending = null;
    const error = params.get('error');
    const code = params.get('code');
    if (error || !code) {
      this.setState({ state: 'signed_out' });
      p.reject(new AuthFlowError(error ? `authorize_${error.slice(0, 40)}` : 'missing_code'));
      return true;
    }
    try {
      const tokens = await this.tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: this.deps.config.clientId,
        code_verifier: p.verifier,
      });
      const user = this.acceptTokens(tokens, p.nonce);
      if (!tokens.refresh_token) throw new AuthFlowError('no_refresh_token');
      this.refreshToken = tokens.refresh_token;
      const persisted = await this.deps.tokenStore.save({ refreshToken: tokens.refresh_token, user });
      if (!persisted) this.deps.log?.('oidc: secure storage unavailable; session kept in memory only');
      this.setState({ state: 'signed_in', user });
      p.resolve();
    } catch (e) {
      this.clearTokens();
      this.setState({ state: 'signed_out' });
      p.reject(e instanceof AuthFlowError ? e : new AuthFlowError('token_exchange_failed'));
    }
    return true;
  }

  /** Validate id_token claims and store it; returns the user. */
  private acceptTokens(tokens: TokenResponse, expectedNonce: string | null): AuthUser {
    if (!tokens.id_token) throw new AuthFlowError('no_id_token');
    const c = decodeJwtPayload(tokens.id_token);
    if (!c) throw new AuthFlowError('bad_id_token');
    const nowSec = Math.floor(this.now() / 1000);
    const aud = c.aud;
    const audOk = Array.isArray(aud) ? aud.includes(this.deps.config.clientId) : aud === this.deps.config.clientId;
    if ((c.iss as string | undefined)?.replace(/\/+$/, '') !== this.issuer) throw new AuthFlowError('bad_iss');
    if (!audOk) throw new AuthFlowError('bad_aud');
    if (typeof c.exp !== 'number' || c.exp < nowSec - 60) throw new AuthFlowError('id_token_expired');
    if (expectedNonce !== null && c.nonce !== expectedNonce) throw new AuthFlowError('bad_nonce');
    if (typeof c.sub !== 'string' || !c.sub) throw new AuthFlowError('bad_sub');
    this.idToken = tokens.id_token;
    this.idTokenExp = c.exp;
    const name =
      typeof c.name === 'string'
        ? c.name
        : [c.given_name, c.family_name].filter((x) => typeof x === 'string' && x).join(' ') || undefined;
    return {
      id: c.sub,
      email: typeof c.email === 'string' ? c.email : '',
      ...(name ? { name } : {}),
    };
  }

  private async tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
    const ep = await this.getEndpoints();
    const res = await this.fetchFn(ep.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      let code = `http_${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (typeof j.error === 'string') code = j.error.slice(0, 40);
      } catch {
        /* ignore */
      }
      throw new AuthFlowError(code);
    }
    return (await res.json()) as TokenResponse;
  }

  // ---------------------------------------------------------------- session restore / refresh

  /**
   * On launch: restore the persisted session. A network failure keeps the user signed in
   * (offline grace is decided by the license gate); an invalid_grant signs them out.
   */
  async restore(): Promise<AuthState> {
    const stored = await this.deps.tokenStore.load();
    if (!stored) return this.getState();
    this.refreshToken = stored.refreshToken;
    this.setState({ state: 'signed_in', user: stored.user });
    try {
      await this.refresh();
    } catch (e) {
      if (e instanceof AuthFlowError && (e.code === 'invalid_grant' || e.code === 'bad_sub_changed')) {
        await this.signOut();
      }
    }
    return this.getState();
  }

  private async refresh(): Promise<string | null> {
    if (!this.refreshToken) return null;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const tokens = await this.tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken!,
        client_id: this.deps.config.clientId,
      });
      const prevUser = this.state.user;
      let user = prevUser;
      if (tokens.id_token) {
        user = this.acceptTokens(tokens, null);
        if (prevUser && user.id !== prevUser.id) throw new AuthFlowError('bad_sub_changed');
      } else {
        throw new AuthFlowError('no_id_token');
      }
      if (tokens.refresh_token && tokens.refresh_token !== this.refreshToken) {
        this.refreshToken = tokens.refresh_token; // rotation
      }
      if (user) {
        await this.deps.tokenStore.save({ refreshToken: this.refreshToken!, user });
        if (this.state.state !== 'signed_in' || JSON.stringify(user) !== JSON.stringify(prevUser)) {
          this.setState({ state: 'signed_in', user });
        }
      }
      return this.idToken;
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /**
   * Bearer token for the license server (Clerk id_token), refreshed when it expires within 60 s.
   * Returns null when signed out. Throws on network failure (caller falls back to cached license).
   */
  async getApiToken(): Promise<string | null> {
    if (this.state.state !== 'signed_in') return null;
    const nowSec = Math.floor(this.now() / 1000);
    if (this.idToken && this.idTokenExp - TOKEN_MIN_TTL_SEC > nowSec) return this.idToken;
    try {
      return await this.refresh();
    } catch (e) {
      if (e instanceof AuthFlowError && (e.code === 'invalid_grant' || e.code === 'bad_sub_changed')) {
        await this.signOut();
        return null;
      }
      throw e;
    }
  }

  async signOut(): Promise<void> {
    this.abortPending(new AuthFlowError('signed_out'));
    const rt = this.refreshToken;
    this.clearTokens();
    await this.deps.tokenStore.clear();
    this.setState({ state: 'signed_out' });
    if (rt && this.endpoints?.revocation_endpoint) {
      // best effort
      void this.fetchFn(this.endpoints.revocation_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: rt, token_type_hint: 'refresh_token', client_id: this.deps.config.clientId }).toString(),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => undefined);
    }
  }

  private clearTokens(): void {
    this.refreshToken = null;
    this.idToken = null;
    this.idTokenExp = 0;
  }
}
