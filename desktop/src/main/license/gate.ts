/**
 * License gate: the backend (airbridge-core daemon) runs ONLY while this says the user holds a
 * valid AirBridge Pro license.
 *
 *  check():  Clerk token -> POST <licenseUrl>/v1/license/verify
 *            200 -> verifyLicenseToken (Ed25519, local) -> cache -> state "valid" -> onValid()
 *            402 -> state "inactive" (checkout_url remembered) -> onInvalid()
 *            401 / no session -> "inactive" -> onInvalid()
 *            network/5xx/bad token -> cached token still verifies (until its exp) -> "grace" -> onValid()
 *                                     otherwise "unknown" (never reached server) / "inactive" (expired) -> onInvalid()
 *  Re-checks every 6 h (15 min while in grace) and re-evaluates exactly at the token's exp.
 *  onValid / onInvalid fire on entitlement transitions only (start/stop are not spammed).
 */
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { LicenseStatus } from '../../shared/types';
import { verifyLicenseToken, type VerifyResult } from './verify';

export const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const GRACE_RETRY_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
/** setTimeout max is 2^31-1 ms (~24.8 days). */
const MAX_TIMER_MS = 2_147_483_647;

export interface LicenseCache {
  load(): Promise<string | null>;
  save(token: string | null): Promise<void>;
}

/** Plain-file cache (0600). The token is signed, not secret; tampering only makes it fail verification. */
export function createFileLicenseCache(filePath: string): LicenseCache {
  return {
    async load() {
      try {
        const t = (await fs.readFile(filePath, 'utf8')).trim();
        return t.length > 0 && t.length < 4096 ? t : null;
      } catch {
        return null;
      }
    },
    async save(token) {
      if (token === null) {
        await fs.rm(filePath, { force: true }).catch(() => undefined);
        return;
      }
      await fs.mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
      const tmp = `${filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, token, { mode: 0o600 });
      await fs.rename(tmp, filePath);
    },
  };
}

export function createMemoryLicenseCache(initial: string | null = null): LicenseCache {
  let v = initial;
  return {
    load: async () => v,
    save: async (t) => {
      v = t;
    },
  };
}

export type InvalidReason = 'signed_out' | 'inactive' | 'expired' | 'unreachable' | 'rejected';

export interface LicenseGateOptions {
  /** Base URL of the license server (AIRBRIDGE_LICENSE_URL), e.g. https://license.example.com */
  licenseUrl: string;
  /** Clerk bearer token for the license server, or null when signed out. May throw on network errors. */
  getAuthToken: () => Promise<string | null>;
  /** Signed-in Clerk user id; tokens for another `sub` are rejected. */
  getUserId: () => string | null;
  /** kid -> SPKI PEM (Security's getLicensePublicKeys()). */
  publicKeys: Readonly<Record<string, string>>;
  onValid: () => void | Promise<void>;
  onInvalid: (reason: InvalidReason) => void | Promise<void>;
  cache?: LicenseCache;
  openExternal?: (url: string) => Promise<void>;
  verify?: (token: string, opts: Parameters<typeof verifyLicenseToken>[1]) => VerifyResult;
  fetch?: typeof fetch;
  now?: () => number;
  refreshIntervalMs?: number;
  log?: (msg: string) => void;
}

type CheckoutHost = 'checkout.stripe.com' | 'billing.stripe.com';
const CHECKOUT_HOSTS: readonly CheckoutHost[] = ['checkout.stripe.com', 'billing.stripe.com'];

/** Only Stripe-hosted https pages may be opened from license-server responses. */
export function isCheckoutUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 4096) return false;
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      (u.port === '' || u.port === '443') &&
      (CHECKOUT_HOSTS as readonly string[]).includes(u.hostname)
    );
  } catch {
    return false;
  }
}

export class LicenseGate {
  private status: LicenseStatus = { state: 'unknown', plan: null, exp: null };
  private entitled: boolean | null = null;
  private listeners = new Set<(s: LicenseStatus) => void>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<LicenseStatus> | null = null;
  private lastCheckoutUrl: string | null = null;
  private started = false;
  private readonly base: string;
  private readonly cache: LicenseCache;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly verify: NonNullable<LicenseGateOptions['verify']>;

  constructor(private readonly opts: LicenseGateOptions) {
    const u = new URL(opts.licenseUrl);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
      throw new Error('AIRBRIDGE_LICENSE_URL must be https (http only for localhost)');
    }
    this.base = u.origin + u.pathname.replace(/\/+$/, '');
    this.cache = opts.cache ?? createMemoryLicenseCache();
    this.fetchFn = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.verify = opts.verify ?? verifyLicenseToken;
  }

  getStatus(): LicenseStatus {
    return { ...this.status };
  }

  onChange(cb: (s: LicenseStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Begin gating: immediate check + periodic re-checks. */
  async start(): Promise<LicenseStatus> {
    this.started = true;
    return this.check();
  }

  /** Stop timers (app quit). Does not call onInvalid. */
  dispose(): void {
    this.started = false;
    this.clearTimers();
  }

  /** Sign-out: forget the cached license and stop the backend. */
  async reset(): Promise<void> {
    this.lastCheckoutUrl = null;
    await this.cache.save(null).catch(() => undefined);
    this.clearTimers();
    await this.apply({ state: 'inactive', plan: null, exp: null }, false, 'signed_out');
  }

  /** Run a check now (deduplicated if one is in flight). */
  check(): Promise<LicenseStatus> {
    if (!this.inflight) {
      this.inflight = this.doCheck().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private verifyToken(token: string): VerifyResult {
    const sub = this.opts.getUserId();
    return this.verify(token, {
      publicKeys: this.opts.publicKeys as Record<string, string>,
      ...(sub ? { expectedSub: sub } : {}),
      now: Math.floor(this.now() / 1000),
    });
  }

  private async doCheck(): Promise<LicenseStatus> {
    let bearer: string | null;
    try {
      bearer = await this.opts.getAuthToken();
    } catch {
      return this.fallbackToCache('unreachable');
    }
    if (!bearer || !this.opts.getUserId()) {
      return this.apply({ state: 'inactive', plan: null, exp: null }, false, 'signed_out');
    }

    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}/v1/license/verify`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return this.fallbackToCache('unreachable');
    }

    if (res.status === 200) {
      let token: unknown;
      try {
        token = ((await res.json()) as { token?: unknown }).token;
      } catch {
        token = null;
      }
      const r = typeof token === 'string' ? this.verifyToken(token) : ({ ok: false, reason: 'malformed' } as const);
      if (r.ok) {
        this.lastCheckoutUrl = null;
        await this.cache.save(token as string).catch(() => undefined);
        return this.apply({ state: 'valid', plan: r.claims.plan, exp: r.claims.exp }, true);
      }
      this.opts.log?.(`license: server token rejected locally (${r.reason})`);
      return this.fallbackToCache('rejected');
    }

    if (res.status === 402) {
      try {
        const body = (await res.json()) as { checkout_url?: unknown };
        this.lastCheckoutUrl = isCheckoutUrl(body.checkout_url) ? body.checkout_url : null;
      } catch {
        this.lastCheckoutUrl = null;
      }
      await this.cache.save(null).catch(() => undefined);
      return this.apply({ state: 'inactive', plan: null, exp: null }, false, 'inactive');
    }

    if (res.status === 401 || res.status === 403) {
      await this.cache.save(null).catch(() => undefined);
      return this.apply({ state: 'inactive', plan: null, exp: null }, false, 'signed_out');
    }

    // 429 / 5xx / anything else: treat as transient.
    return this.fallbackToCache('unreachable');
  }

  private async fallbackToCache(why: InvalidReason): Promise<LicenseStatus> {
    const cached = await this.cache.load().catch(() => null);
    if (cached) {
      const r = this.verifyToken(cached);
      if (r.ok) return this.apply({ state: 'grace', plan: r.claims.plan, exp: r.claims.exp }, true);
      if (r.reason === 'expired') {
        await this.cache.save(null).catch(() => undefined);
        return this.apply({ state: 'inactive', plan: null, exp: null }, false, 'expired');
      }
    }
    return this.apply({ state: 'unknown', plan: null, exp: null }, false, why);
  }

  private async apply(next: LicenseStatus, entitled: boolean, reason: InvalidReason = 'inactive'): Promise<LicenseStatus> {
    const changed =
      next.state !== this.status.state || next.plan !== this.status.plan || next.exp !== this.status.exp;
    this.status = next;
    if (changed) {
      for (const l of this.listeners) {
        try {
          l(this.getStatus());
        } catch {
          /* ignore */
        }
      }
    }
    const was = this.entitled;
    this.entitled = entitled;
    this.schedule();
    try {
      if (entitled && was !== true) await this.opts.onValid();
      else if (!entitled && was !== false) await this.opts.onInvalid(reason);
    } catch (e) {
      this.opts.log?.(`license: transition handler failed: ${(e as Error).message}`);
    }
    return this.getStatus();
  }

  private clearTimers(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.refreshTimer = null;
    this.expiryTimer = null;
  }

  private schedule(): void {
    this.clearTimers();
    if (!this.started) return;
    const interval =
      this.status.state === 'grace' || this.status.state === 'unknown'
        ? GRACE_RETRY_MS
        : (this.opts.refreshIntervalMs ?? REFRESH_INTERVAL_MS);
    // While signed out there's nothing to poll; sign-in triggers check() explicitly.
    if (!(this.status.state === 'inactive' && !this.opts.getUserId())) {
      this.refreshTimer = setTimeout(() => void this.check(), interval);
      this.refreshTimer.unref?.();
    }
    if (this.entitled && this.status.exp !== null) {
      const ms = Math.max(0, this.status.exp * 1000 - this.now());
      this.expiryTimer = setTimeout(() => void this.check(), Math.min(ms + 1000, MAX_TIMER_MS));
      this.expiryTimer.unref?.();
    }
  }

  /**
   * Open Stripe Checkout (or the billing portal for existing subscribers) in the system browser.
   * Asks the server for a fresh session; falls back to the checkout_url from the last 402.
   */
  async openCheckout(): Promise<void> {
    const open = this.opts.openExternal;
    if (!open) throw new Error('openExternal not configured');
    let url: string | null = null;
    try {
      const bearer = await this.opts.getAuthToken();
      if (bearer) {
        const res = await this.fetchFn(`${this.base}/v1/billing/checkout`, {
          method: 'POST',
          headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (res.ok) {
          const body = (await res.json()) as { url?: unknown };
          if (isCheckoutUrl(body.url)) url = body.url;
        }
      }
    } catch {
      /* fall back below */
    }
    url ??= this.lastCheckoutUrl;
    if (!url) throw new Error('checkout_unavailable');
    await open(url);
  }
}
