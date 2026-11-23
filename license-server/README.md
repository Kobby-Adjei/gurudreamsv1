# AirBridge license server

Small HTTPS service behind **AirBridge Pro** ($15/month). It:

1. receives Stripe webhooks and keeps one subscription record per Clerk user,
2. verifies the desktop app's Clerk JWT and, for `active`/`trialing` subscribers, returns a short-lived
   **Ed25519-signed license token** that the desktop verifies offline,
3. creates Stripe Checkout sessions for everyone else,
4. (Phase 3) issues single-use **Headscale pre-auth keys** so the desktop app can join the customer's private
   network, and takes a customer's devices off that network when the subscription lapses.

Stack: Node 22, TypeScript, [Hono](https://hono.dev), `stripe`, `jose`, `pg`. Security notes: [`SECURITY.md`](./SECURITY.md).

## API

| Method & path | Auth | Response |
|---|---|---|
| `GET /healthz` | – | `{ok:true}` |
| `POST /v1/stripe/webhook` | `Stripe-Signature` | `200 {received:true}` · `400` bad/missing signature · `500` processing failed (Stripe retries) |
| `POST /v1/license/verify` | `Authorization: Bearer <Clerk JWT>` | `200 {token, status, exp}` · `401` · `402 {status, checkout_url}` · `429` |
| `POST /v1/billing/checkout` | `Authorization: Bearer <Clerk JWT>` | `200 {url}` — Checkout for non-subscribers, Billing Portal for active subscribers |
| `GET /checkout/success`, `/checkout/cancel` | – | Small landing pages Checkout redirects to |
| `POST /v1/network/preauth-key` | `Authorization: Bearer <Clerk JWT>` | `200 {auth_key, login_server, expires_at}` (`Cache-Control: no-store`; `expires_at` unix seconds) · `401` · `402 {error:"subscription_required", status}` · `429` · `502` Headscale error · `503` network not configured |
| `POST /v1/network/devices/:id/remove` | `Authorization: Bearer <Clerk JWT>` | `200 {removed:true}` · `401` · `404` unknown node **or another customer's node** · `429` · `502` · `503` |

### Private network (Headscale)

One Headscale user per customer, named `u-<first 20 hex of sha256(clerk sub)>` — no email or Clerk id is sent
to Headscale. `preauth-key` (entitled users only) ensures that user exists (`GET /api/v1/user?name=` →
`POST /api/v1/user`; Headscale reports a concurrent duplicate as HTTP 500, so a failed create is followed by
one re-GET) and creates a **single-use, non-ephemeral** key expiring after `PREAUTH_TTL_SECONDS` (600 s).
Rate limits (per process): 5/min per user, 1000/day globally, 60/min per IP. Keys are never logged.
Headscale errors become `502 {error:"upstream_unavailable"}`; upstream bodies are never forwarded or logged.

When a webhook moves a user to a non-entitled status (`past_due`, `canceled`, `unpaid`, `incomplete`), all of
that user's Headscale nodes are deleted (best-effort: failures are logged, the webhook still succeeds).
Re-subscribing re-enrolls automatically on the next app start.

Headscale deployment kit (Docker Compose + Caddy, policy, config): [`headscale/README.md`](./headscale/README.md).

License token (compact JWS): header `{alg:"EdDSA", typ:"airbridge-license+jwt", kid}`, payload
`{iss:"airbridge-license", aud:"airbridge-desktop", sub:<clerk user id>, plan:"airbridge_pro", status, iat, exp}`;
`exp = iat + LICENSE_TTL_SECONDS` (default 72 h — the desktop's offline grace window).

Webhook handling: the raw body is verified with `stripe.webhooks.constructEvent` (5-minute tolerance).
`checkout.session.completed` and `customer.subscription.created|updated|deleted` are handled; for each,
the server re-fetches the subscription from Stripe (so out-of-order deliveries can't regress state), maps it to
the user via `metadata.clerk_user_id` (set on both the Checkout Session and `subscription_data`), and stores
`active | trialing | past_due | canceled | unpaid | incomplete` (`incomplete_expired → canceled`,
`paused → unpaid`). Event ids are recorded after successful processing, so replays are no-ops. A
cancellation of an *older* subscription never revokes a newer active one.

## Local development

```bash
cd license-server
npm install
npm test                    # fully offline (local keys, mocked Stripe/Clerk)
npm run keys:generate       # prints a new Ed25519 keypair
cp .env.example .env        # fill in values; then:
set -a; . ./.env; set +a; npm run dev
```

Without `DATABASE_URL` the server uses an in-memory store (refused when `NODE_ENV=production`).

## Environment

| Variable | Notes |
|---|---|
| `STRIPE_SECRET_KEY` | Secret or restricted key. Restricted key needs: Checkout Sessions write, Subscriptions read, Customer portal write. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the webhook endpoint (`whsec_…`). |
| `STRIPE_PRICE_ID_PRO` | Price id of the $15/month "AirBridge Pro" price. |
| `CLERK_ISSUER` | Clerk Frontend API URL, e.g. `https://<instance>.clerk.accounts.dev` (or your custom Clerk domain). |
| `CLERK_JWKS_URL` | `<CLERK_ISSUER>/.well-known/jwks.json` |
| `CLERK_AUDIENCE` | The Clerk **OAuth application client ID** (comma-separate to accept several). |
| `LICENSE_SIGNING_KEY_PEM` | Ed25519 PKCS8 PEM from `npm run keys:generate`. Single-line `\n`-escaped form accepted. |
| `LICENSE_KEY_ID` | `kid` placed in the token header; must match the desktop's `LICENSE_PUBLIC_KEYS` key. |
| `LICENSE_TTL_SECONDS` | Default `259200` (72 h). 300 … 2 592 000. |
| `DATABASE_URL` | Postgres connection string. Required in production. |
| `PUBLIC_BASE_URL` | Public `https://` origin of this server (Checkout success/cancel URLs). **Required in production**; `X-Forwarded-Host` is never trusted. |
| `TRUST_PROXY` | `1` behind Railway/Fly/Vercel so rate limiting uses `X-Forwarded-For` (rightmost entry appended by the proxy — client-supplied entries are ignored). |
| `TRUST_PROXY_HOPS` | Number of trusted proxies in front of the app (default `1`). |
| `PORT` | Default `8787`. |
| `HEADSCALE_URL` | Where this server reaches the Headscale REST API (`https://`, `http://` only for localhost). Unset together with the next two → `/v1/network/*` answer 503. |
| `HEADSCALE_API_KEY` | **Secret.** `headscale apikeys create --expiration 90d` (see `headscale/README.md` for rotation). |
| `HEADSCALE_PUBLIC_URL` | Public login server URL clients enroll with (Headscale `server_url`), e.g. `https://hs.example.com`. |
| `PREAUTH_TTL_SECONDS` | Pre-auth key lifetime, default `600` (60 … 3600). |

Config is validated at boot; the process exits with code 2 and lists every problem.

## Setup

### 1. Signing keys
```bash
npm run keys:generate
```
Put the private PEM + key id into the server env (`LICENSE_SIGNING_KEY_PEM`, `LICENSE_KEY_ID`). Put the
public PEM under the same key id into `desktop/src/main/license/publicKeys.ts` (`LICENSE_PUBLIC_KEYS`) at
build time. **Rotation:** generate a new pair with a new kid, ship a desktop build containing both public
keys, then switch the server to the new private key; drop the old public key in a later release.

### 2. Stripe product
1. Dashboard → **Product catalog → Add product**: name **AirBridge Pro**, recurring price **$15.00 USD / month**.
   Copy the price id → `STRIPE_PRICE_ID_PRO`.
2. **Settings → Billing → Customer portal**: enable it (cancel, update payment method) — used for existing subscribers.
3. **Developers → Webhooks → Add endpoint**: URL `https://<your-host>/v1/stripe/webhook`, events
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`. Copy the signing secret → `STRIPE_WEBHOOK_SECRET`.
4. Local testing: `stripe listen --forward-to localhost:8787/v1/stripe/webhook` prints a temporary `whsec_…`.

Use test-mode keys end-to-end first; switch to live keys + a live webhook endpoint at launch.

### 3. Clerk OAuth application
1. Clerk Dashboard → **Configure → OAuth applications → Add**: name "AirBridge Desktop", **public client**
   (PKCE, no client secret), scopes `openid profile email offline_access`.
2. Redirect URI: `airbridge://auth/callback`.
3. Copy the **client ID** → desktop `CLERK_OAUTH_CLIENT_ID` and server `CLERK_AUDIENCE`.
4. Issuer = your Frontend API URL → desktop `CLERK_OAUTH_ISSUER` and server `CLERK_ISSUER`.

The desktop app sends the OIDC **id_token** (a JWT whose `aud` is the client ID, signed with the instance
JWKS) as the bearer token, refreshing it with the refresh token when needed. If you enable JWT-format OAuth
access tokens instead, add their audience to `CLERK_AUDIENCE`.

### 4. Database
```bash
psql "$DATABASE_URL" -f migrations/001.sql        # or: npm run migrate
```

## Deploy

All hosts must serve HTTPS (Stripe and Clerk require it). Set the env vars above in the host's secret store.

**Railway** — New Project → Deploy from repo, root directory `license-server` (the Dockerfile is detected).
Add the Postgres plugin (it injects `DATABASE_URL`), set env vars incl. `TRUST_PROXY=1`, `NODE_ENV=production`, `PUBLIC_BASE_URL`,
run the migration once (`railway run psql "$DATABASE_URL" -f migrations/001.sql`), generate a domain, and
point the Stripe webhook at it. Health check path: `/healthz`.

**Fly.io**
```bash
cd license-server
fly launch --no-deploy            # uses the Dockerfile; internal_port 8787
fly postgres create && fly postgres attach <db-app>
fly secrets set STRIPE_SECRET_KEY=... STRIPE_WEBHOOK_SECRET=... STRIPE_PRICE_ID_PRO=... \
  CLERK_ISSUER=... CLERK_JWKS_URL=... CLERK_AUDIENCE=... LICENSE_KEY_ID=... \
  LICENSE_SIGNING_KEY_PEM="$(cat license-private.pem)" TRUST_PROXY=1 NODE_ENV=production \
  PUBLIC_BASE_URL=https://<app>.fly.dev
fly deploy
fly ssh console -C "sh -c 'apt-get update && apt-get install -y postgresql-client && psql \"$DATABASE_URL\" -f migrations/001.sql'"
```

**Vercel** — Import the repo with root directory `license-server`. `api/index.ts` exports the Hono app
(Node.js runtime) and `vercel.json` rewrites every path to it. Use a managed Postgres (Neon/Supabase)
for `DATABASE_URL`. Note: the rate limiter is per-instance in serverless; add Vercel Firewall rate limits
if you need a global limit.

## Tests

`npm test` runs entirely offline: Ed25519 and RS256 keys are generated per run, Clerk's JWKS is a local key
set, Stripe signatures come from `stripe.webhooks.generateTestHeaderString`, and Checkout/Subscriptions use a
fake `BillingApi`; Headscale is an in-memory fake of its v0.29.7 REST API behind an injected `fetch`
(`tests/network.test.ts`). If `desktop/src/main/license/verify.ts` exists, a cross-check confirms tokens from this
server pass the desktop verifier.
