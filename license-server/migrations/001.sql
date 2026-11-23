-- AirBridge license server schema v1. Idempotent; run with `npm run migrate` or psql -f.
CREATE TABLE IF NOT EXISTS subscriptions (
  clerk_user_id          TEXT PRIMARY KEY,
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  status                 TEXT NOT NULL CHECK (status IN ('active','trialing','past_due','canceled','unpaid','incomplete')),
  current_period_end     BIGINT,
  last_event_created     BIGINT NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscriptions_stripe_customer_idx ON subscriptions (stripe_customer_id);

CREATE TABLE IF NOT EXISTS processed_stripe_events (
  event_id     TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
