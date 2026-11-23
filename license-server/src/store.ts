/** Subscription persistence. One record per Clerk user (the user's current/most relevant subscription). */

export const SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export function isEntitled(status: SubscriptionStatus | null | undefined): boolean {
  return status === 'active' || status === 'trialing';
}

export interface SubscriptionRecord {
  clerkUserId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  status: SubscriptionStatus;
  /** unix seconds */
  currentPeriodEnd: number | null;
  /** Stripe `event.created` (unix seconds) of the event that produced this state; used to drop stale out-of-order events. */
  lastEventCreated: number;
}

export interface SubscriptionStore {
  get(clerkUserId: string): Promise<SubscriptionRecord | null>;
  /**
   * Insert or update. Implementations MUST ignore the write when the stored record has a newer
   * `lastEventCreated` (Stripe does not guarantee event ordering). Returns true when applied.
   */
  upsert(record: SubscriptionRecord): Promise<boolean>;
  /** True when this Stripe event id was already fully processed. */
  hasProcessedEvent(eventId: string): Promise<boolean>;
  /** Record a Stripe event id as processed (idempotent). */
  markEventProcessed(eventId: string, type: string): Promise<void>;
  close?(): Promise<void>;
}

export class InMemorySubscriptionStore implements SubscriptionStore {
  private readonly subs = new Map<string, SubscriptionRecord>();
  private readonly events = new Set<string>();

  async get(clerkUserId: string): Promise<SubscriptionRecord | null> {
    const r = this.subs.get(clerkUserId);
    return r ? { ...r } : null;
  }

  async upsert(record: SubscriptionRecord): Promise<boolean> {
    const existing = this.subs.get(record.clerkUserId);
    if (existing && existing.lastEventCreated > record.lastEventCreated) return false;
    this.subs.set(record.clerkUserId, {
      ...record,
      // keep previously known customer id if the new event lacks one
      stripeCustomerId: record.stripeCustomerId ?? existing?.stripeCustomerId ?? null,
    });
    return true;
  }

  async hasProcessedEvent(eventId: string): Promise<boolean> {
    return this.events.has(eventId);
  }

  async markEventProcessed(eventId: string): Promise<void> {
    this.events.add(eventId);
  }
}

/** Minimal subset of `pg.Pool` used here (lets tests inject a fake). */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
  end?(): Promise<void>;
}

function toStatus(s: string): SubscriptionStatus {
  return (SUBSCRIPTION_STATUSES as readonly string[]).includes(s) ? (s as SubscriptionStatus) : 'incomplete';
}

/** Postgres store. Schema: migrations/001.sql. */
export class PostgresSubscriptionStore implements SubscriptionStore {
  constructor(private readonly db: Queryable) {}

  async get(clerkUserId: string): Promise<SubscriptionRecord | null> {
    const { rows } = await this.db.query(
      `SELECT clerk_user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, last_event_created
         FROM subscriptions WHERE clerk_user_id = $1`,
      [clerkUserId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      clerkUserId: r.clerk_user_id,
      stripeCustomerId: r.stripe_customer_id ?? null,
      stripeSubscriptionId: r.stripe_subscription_id ?? null,
      status: toStatus(r.status),
      currentPeriodEnd: r.current_period_end == null ? null : Number(r.current_period_end),
      lastEventCreated: Number(r.last_event_created),
    };
  }

  async upsert(record: SubscriptionRecord): Promise<boolean> {
    const res = await this.db.query(
      `INSERT INTO subscriptions
         (clerk_user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, last_event_created, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (clerk_user_id) DO UPDATE SET
         stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, subscriptions.stripe_customer_id),
         stripe_subscription_id = EXCLUDED.stripe_subscription_id,
         status = EXCLUDED.status,
         current_period_end = EXCLUDED.current_period_end,
         last_event_created = EXCLUDED.last_event_created,
         updated_at = now()
       WHERE subscriptions.last_event_created <= EXCLUDED.last_event_created`,
      [
        record.clerkUserId,
        record.stripeCustomerId,
        record.stripeSubscriptionId,
        record.status,
        record.currentPeriodEnd,
        record.lastEventCreated,
      ],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async hasProcessedEvent(eventId: string): Promise<boolean> {
    const { rows } = await this.db.query('SELECT 1 FROM processed_stripe_events WHERE event_id = $1', [eventId]);
    return rows.length > 0;
  }

  async markEventProcessed(eventId: string, type: string): Promise<void> {
    await this.db.query(
      'INSERT INTO processed_stripe_events (event_id, type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING',
      [eventId, type],
    );
  }

  async close(): Promise<void> {
    await this.db.end?.();
  }
}
