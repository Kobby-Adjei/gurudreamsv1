/**
 * Landing-page demand test: waitlist sign-ups and page views.
 *
 *  POST /v1/waitlist             {email, variant, price, referrer?, utm_source?, utm_medium?, utm_campaign?, company?}
 *  POST /v1/waitlist/view        {variant, price}                    (no PII; conversion denominator)
 *  GET  /v1/waitlist/stats       Bearer WAITLIST_ADMIN_TOKEN         counts only, never emails
 *  GET  /v1/waitlist/export      Bearer WAITLIST_ADMIN_TOKEN         CSV with emails (for the founder)
 *
 * Storage: one append-only JSONL file (dir 0700, file 0600), one O_APPEND write per line. The file is replayed
 * into memory on first use; it is the only source of truth. Emails are stored (we must contact people) but are
 * never logged and never echoed in a response.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Context, Hono } from 'hono';
import { RateLimiter } from './rateLimit.js';

export const VARIANTS = ['private', 'cross', 'bridge', 'current'] as const;
export const PRICES = [8, 15] as const;
export type Variant = (typeof VARIANTS)[number];
export type Price = (typeof PRICES)[number];

export const DEFAULT_WAITLIST_PATH = '/data/waitlist/waitlist.jsonl';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MAX_BODY_BYTES = 4096;

export interface SignupRecord {
  kind: 'signup';
  ts: string;
  email: string;
  variant: Variant;
  price: Price;
  referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
}
/** A later submission for an email already on the list: first touch is kept, the repeat is only counted. */
export interface RepeatRecord {
  kind: 'repeat';
  ts: string;
  email: string;
  variant: Variant;
  price: Price;
}
export interface ViewRecord {
  kind: 'view';
  ts: string;
  variant: Variant;
  price: Price;
}
type WaitlistLine = SignupRecord | RepeatRecord | ViewRecord;

// ------------------------------------------------------------------------------------------- validation

const EMAIL_LOCAL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const EMAIL_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const UTM = /^[A-Za-z0-9._-]{1,64}$/;

/** RFC-ish address check on the trimmed, lowercased value. Returns the normalized email or null. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at !== email.indexOf('@')) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || !EMAIL_LOCAL.test(local)) return null;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((l) => EMAIL_LABEL.test(l))) return null;
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(labels[labels.length - 1]!)) return null; // TLD: not numeric, ≥2 chars
  return email;
}

export function parseVariant(v: unknown): Variant | null {
  return typeof v === 'string' && (VARIANTS as readonly string[]).includes(v) ? (v as Variant) : null;
}

export function parsePrice(v: unknown): Price | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,3}$/.test(v) ? Number(v) : NaN;
  return (PRICES as readonly number[]).includes(n) ? (n as Price) : null;
}

/** utm_* : [A-Za-z0-9._-]{1,64}; anything else (absent, empty, invalid) is dropped to null, never rejected. */
export function parseUtm(v: unknown): string | null {
  return typeof v === 'string' && UTM.test(v) ? v : null;
}

/** Referrer reduced to its origin (http/https only, ≤200 chars); anything else -> null. */
export function parseReferrer(v: unknown): string | null {
  if (typeof v !== 'string' || !v || v.length > 2048) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin.length <= 200 ? u.origin : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------- storage

export interface WaitlistStore {
  /** true -> new first-touch signup; false -> email already listed (repeat counted). */
  addSignup(rec: Omit<SignupRecord, 'kind'>): boolean;
  addView(rec: Omit<ViewRecord, 'kind'>): void;
  signups(): ReadonlyArray<SignupRecord & { repeats: number }>;
  viewCounts(): ReadonlyMap<string, number>;
  repeatCount(): number;
}

const cellKey = (variant: string, price: number) => `${variant}:${price}`;

/** Append-only JSONL file store. Opened lazily; if opening fails, the next call retries. */
export class JsonlWaitlistStore implements WaitlistStore {
  private fd: number | null = null;
  private readonly byEmail = new Map<string, SignupRecord & { repeats: number }>();
  private readonly views = new Map<string, number>();
  private repeats = 0;

  constructor(readonly filePath: string) {}

  /** Create the directory (0700) and file (0600), replay existing lines, keep an O_APPEND fd open. */
  open(): void {
    if (this.fd !== null) return;
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* not our directory (e.g. a root-owned volume mount we can still write to) */
    }
    const fd = fs.openSync(this.filePath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      this.replay();
      // A crash mid-write can leave a partial last line; start ours on a fresh line.
      const size = fs.fstatSync(fd).size;
      if (size > 0) {
        const last = Buffer.alloc(1);
        const rfd = fs.openSync(this.filePath, 'r');
        try {
          fs.readSync(rfd, last, 0, 1, size - 1);
        } finally {
          fs.closeSync(rfd);
        }
        if (last[0] !== 0x0a) fs.writeSync(fd, '\n');
      }
    } catch (e) {
      fs.closeSync(fd);
      this.byEmail.clear();
      this.views.clear();
      this.repeats = 0;
      throw e;
    }
    this.fd = fd;
  }

  close(): void {
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
  }

  private replay(): void {
    const text = fs.readFileSync(this.filePath, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec: WaitlistLine;
      try {
        rec = JSON.parse(line) as WaitlistLine;
      } catch {
        continue; // torn line from a crash: skip
      }
      this.apply(rec);
    }
  }

  private apply(rec: WaitlistLine): void {
    if (rec.kind === 'signup' && typeof rec.email === 'string') {
      if (!this.byEmail.has(rec.email)) this.byEmail.set(rec.email, { ...rec, repeats: 0 });
      else this.bumpRepeat(rec.email);
    } else if (rec.kind === 'repeat' && typeof rec.email === 'string') {
      this.bumpRepeat(rec.email);
    } else if (rec.kind === 'view') {
      const k = cellKey(rec.variant, rec.price);
      this.views.set(k, (this.views.get(k) ?? 0) + 1);
    }
  }

  private bumpRepeat(email: string): void {
    const s = this.byEmail.get(email);
    if (s) s.repeats += 1;
    this.repeats += 1;
  }

  private append(rec: WaitlistLine): void {
    this.open();
    // One write(2) of one complete line on an O_APPEND fd: concurrent writers never interleave mid-line.
    fs.writeSync(this.fd!, Buffer.from(JSON.stringify(rec) + '\n', 'utf8'));
    this.apply(rec);
  }

  addSignup(r: Omit<SignupRecord, 'kind'>): boolean {
    this.open();
    if (this.byEmail.has(r.email)) {
      this.append({ kind: 'repeat', ts: r.ts, email: r.email, variant: r.variant, price: r.price });
      return false;
    }
    this.append({ kind: 'signup', ...r });
    return true;
  }

  addView(r: Omit<ViewRecord, 'kind'>): void {
    this.append({ kind: 'view', ...r });
  }

  signups() {
    this.open();
    return [...this.byEmail.values()];
  }

  viewCounts() {
    this.open();
    return this.views;
  }

  repeatCount() {
    this.open();
    return this.repeats;
  }
}

// ------------------------------------------------------------------------------------------- routes

export interface WaitlistLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface WaitlistRouteDeps {
  store: WaitlistStore;
  /** WAITLIST_ADMIN_TOKEN; null/empty -> /stats and /export answer 404. */
  adminToken: string | null;
  /** Expected browser Origin (PUBLIC_BASE_URL origin, or the request's own origin in local dev). */
  expectedOrigin: (c: Context) => string;
  clientIp: (c: Context) => string;
  now: () => number;
  log: WaitlistLogger;
  limits?: {
    signupPerIpPerHour?: number;
    signupGlobalPerDay?: number;
    viewPerIpPerHour?: number;
    viewGlobalPerDay?: number;
    adminPerIpPerMinute?: number;
  };
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** Constant-time bearer check (both sides hashed to a fixed length first). */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer ([^\s]+)$/.exec(header ?? '');
  const presented = sha256(m ? m[1]! : '');
  const ok = timingSafeEqual(presented, sha256(token));
  return ok && !!m;
}

/** CSV cell: quote always, double quotes, and defuse spreadsheet formulas (=, +, -, @, tab, CR). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function registerWaitlistRoutes(app: Hono, deps: WaitlistRouteDeps): void {
  const { store, log, now } = deps;
  const L = deps.limits ?? {};
  const signupPerIp = new RateLimiter(L.signupPerIpPerHour ?? 5, HOUR_MS, now);
  const signupGlobal = new RateLimiter(L.signupGlobalPerDay ?? 2000, DAY_MS, now);
  const viewPerIp = new RateLimiter(L.viewPerIpPerHour ?? 60, HOUR_MS, now);
  const viewGlobal = new RateLimiter(L.viewGlobalPerDay ?? 50_000, DAY_MS, now);
  const adminPerIp = new RateLimiter(L.adminPerIpPerMinute ?? 10, 60_000, now);
  let honeypotSinceBoot = 0;
  const adminToken = deps.adminToken?.trim() || null;

  const unavailable = (c: Context, e: unknown) => {
    log.error('waitlist_storage_error', { err: (e as Error).message });
    return c.json({ error: 'waitlist_unavailable' }, 503);
  };

  /** Same-origin only: a browser Origin (or Sec-Fetch-Site) from another site -> 403. */
  const crossOrigin = (c: Context): boolean => {
    const origin = c.req.header('origin');
    if (origin !== undefined && origin !== deps.expectedOrigin(c)) return true;
    return c.req.header('sec-fetch-site') === 'cross-site';
  };

  /** Read a small JSON object body; returns a Response on failure. */
  const readJson = async (c: Context, allowTextPlain: boolean): Promise<Record<string, unknown> | Response> => {
    const ct = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (ct !== 'application/json' && !(allowTextPlain && ct === 'text/plain')) {
      return c.json({ error: 'unsupported_media_type' }, 415);
    }
    if (Number(c.req.header('content-length') ?? '0') > MAX_BODY_BYTES) return c.json({ error: 'payload_too_large' }, 413);
    const raw = await c.req.arrayBuffer();
    if (raw.byteLength > MAX_BODY_BYTES) return c.json({ error: 'payload_too_large' }, 413);
    try {
      const body = JSON.parse(Buffer.from(raw).toString('utf8')) as unknown;
      if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
    } catch {
      /* fallthrough */
    }
    return c.json({ error: 'invalid_json' }, 400);
  };

  const OK = { ok: true } as const;

  app.post('/v1/waitlist', async (c) => {
    if (crossOrigin(c)) return c.json({ error: 'forbidden' }, 403);
    if (!signupPerIp.allow(deps.clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
    const body = await readJson(c, false);
    if (body instanceof Response) return body;

    // Honeypot: bots fill the hidden "company" field. Look successful, store nothing.
    if (body.company !== undefined && body.company !== null && body.company !== '') {
      honeypotSinceBoot += 1;
      log.info('waitlist_honeypot');
      return c.json(OK);
    }

    const email = normalizeEmail(body.email);
    const variant = parseVariant(body.variant);
    const price = parsePrice(body.price);
    const invalid = [!email && 'email', !variant && 'variant', !price && 'price'].filter(Boolean);
    if (invalid.length) return c.json({ error: 'invalid_request', fields: invalid }, 400);

    if (!signupGlobal.allow('global')) {
      log.warn('waitlist_global_limit');
      return c.json({ error: 'rate_limited' }, 429);
    }
    let isNew: boolean;
    try {
      isNew = store.addSignup({
        ts: new Date(now()).toISOString(),
        email: email!,
        variant: variant!,
        price: price!,
        referrer: parseReferrer(body.referrer),
        utm_source: parseUtm(body.utm_source),
        utm_medium: parseUtm(body.utm_medium),
        utm_campaign: parseUtm(body.utm_campaign),
      });
    } catch (e) {
      return unavailable(c, e);
    }
    // Never log the email. The response is identical for new and repeat sign-ups (no list enumeration).
    log.info(isNew ? 'waitlist_signup' : 'waitlist_repeat', { variant, price });
    return c.json(OK);
  });

  app.post('/v1/waitlist/view', async (c) => {
    if (crossOrigin(c)) return c.json({ error: 'forbidden' }, 403);
    if (!viewPerIp.allow(deps.clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
    // text/plain is accepted so the page can use navigator.sendBeacon without a Blob type.
    const body = await readJson(c, true);
    if (body instanceof Response) return body;
    const variant = parseVariant(body.variant);
    const price = parsePrice(body.price);
    if (!variant || !price) {
      return c.json({ error: 'invalid_request', fields: [!variant && 'variant', !price && 'price'].filter(Boolean) }, 400);
    }
    if (!viewGlobal.allow('global')) return c.json({ error: 'rate_limited' }, 429);
    try {
      store.addView({ ts: new Date(now()).toISOString(), variant, price });
    } catch (e) {
      return unavailable(c, e);
    }
    return c.json(OK);
  });

  /** 404 when no admin token is configured (endpoint does not exist); 401 on a wrong token. */
  const admin = (c: Context): Response | null => {
    if (!adminToken) return c.json({ error: 'not_found' }, 404);
    if (!adminPerIp.allow(deps.clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
    if (!bearerMatches(c.req.header('authorization'), adminToken)) {
      log.warn('waitlist_admin_unauthorized');
      return c.json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
    }
    return null;
  };

  app.get('/v1/waitlist/stats', (c) => {
    const denied = admin(c);
    if (denied) return denied;
    try {
      const signups = store.signups();
      const views = store.viewCounts();
      const cells = VARIANTS.flatMap((variant) =>
        PRICES.map((price) => {
          const v = views.get(cellKey(variant, price)) ?? 0;
          const s = signups.filter((r) => r.variant === variant && r.price === price).length;
          return { variant, price, views: v, signups: s, conversion: v > 0 ? Math.round((s / v) * 10_000) / 10_000 : null };
        }),
      );
      const bySource: Record<string, number> = {};
      for (const r of signups) {
        const k = r.utm_source ?? '(none)';
        bySource[k] = (bySource[k] ?? 0) + 1;
      }
      const totalViews = [...views.values()].reduce((a, b) => a + b, 0);
      return c.json({
        totals: {
          views: totalViews,
          signups: signups.length,
          repeat_submissions: store.repeatCount(),
          conversion: totalViews > 0 ? Math.round((signups.length / totalViews) * 10_000) / 10_000 : null,
          honeypot_since_boot: honeypotSinceBoot,
        },
        by_variant_price: cells,
        by_utm_source: bySource,
      });
    } catch (e) {
      return unavailable(c, e);
    }
  });

  app.get('/v1/waitlist/export', (c) => {
    const denied = admin(c);
    if (denied) return denied;
    let rows: ReadonlyArray<SignupRecord & { repeats: number }>;
    try {
      rows = store.signups();
    } catch (e) {
      return unavailable(c, e);
    }
    const cols = ['ts', 'email', 'variant', 'price', 'referrer', 'utm_source', 'utm_medium', 'utm_campaign', 'repeats'] as const;
    const csv = [cols.join(','), ...rows.map((r) => cols.map((k) => csvCell(r[k])).join(','))].join('\r\n') + '\r\n';
    log.info('waitlist_export', { rows: rows.length });
    return c.body(csv, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="waitlist.csv"',
    });
  });
}
