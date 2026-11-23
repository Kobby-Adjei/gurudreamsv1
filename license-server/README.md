# AirBridge license server

Small HTTPS service behind **AirBridge Pro** ($15/month). It:

1. receives Stripe webhooks and keeps one subscription record per Clerk user,
2. verifies the desktop app's Clerk JWT and, for `active`/`trialing` subscribers, returns a short-lived
   **Ed25519-signed license token** that the desktop verifies offline,
3. creates Stripe Checkout sessions for everyone else,
4. collects the landing-page **waitlist** (demand test: sign-ups and page views per headline/price variant),
5. (Phase 3) issues single-use **Headscale pre-auth keys** so the desktop app can join the customer's private
   network, and takes a customer's devices off that network when the subscription lapses.

Stack: Node 22, TypeScript, [Hono](https://hono.dev), `stripe`, `jose`, `pg`. Security notes: [`SECURITY.md`](./SECURITY.md).

## API

| Method & path | Auth | Response |
|---|---|---|
| `GET /healthz` | – | `{ok:true, policy}` — `policy` is the Headscale policy guard's last verdict: `verified` (pre-auth keys can be issued), `mismatch`, `unverifiable`, `pending`, or `not_configured` (no Headscale). Never triggers a Headscale call. |
| `GET /v1/license/public-key` | – | `{kid, alg:"EdDSA", pem}`: SPKI PEM of the signing key's public half, for the desktop build's `LICENSE_PUBLIC_KEYS` |
| `POST /v1/stripe/webhook` | `Stripe-Signature` | `200 {received:true}` · `400` bad/missing signature · `500` processing failed (Stripe retries) |
| `POST /v1/license/verify` | `Authorization: Bearer <Clerk JWT>` | `200 {token, status, exp}` · `401` · `402 {status, checkout_url}` · `429` |
| `POST /v1/billing/checkout` | `Authorization: Bearer <Clerk JWT>` | `200 {url}` — Checkout for non-subscribers, Billing Portal for active subscribers |
| `GET /checkout/success`, `/checkout/cancel` | – | Small landing pages Checkout redirects to |
| `POST /v1/network/preauth-key` | `Authorization: Bearer <Clerk JWT>` | `200 {auth_key, login_server, expires_at}` (`Cache-Control: no-store`; `expires_at` unix seconds) · `401` · `402 {error:"subscription_required", status}` · `429` · `502` Headscale error · `503` network not configured |
| `POST /v1/network/devices/:id/remove` | `Authorization: Bearer <Clerk JWT>` | `200 {removed:true}` · `401` · `404` unknown node **or another customer's node** · `429` · `502` · `503` |
| `POST /v1/waitlist` | same-origin browser (no auth) | JSON `{email, variant, price, referrer?, utm_source?, utm_medium?, utm_campaign?, company?}` → `200 {ok:true}` (also for repeats and honeypot hits) · `400 {error:"invalid_request", fields}` · `403` cross-origin · `413` · `415` not JSON · `429` · `503 waitlist_unavailable` |
| `POST /v1/waitlist/view` | same-origin browser (no auth) | JSON (or `text/plain` JSON, for `sendBeacon`) `{variant, price}` → `200 {ok:true}` · `400` · `403` · `429` |
| `GET /v1/waitlist/stats` | `Authorization: Bearer <WAITLIST_ADMIN_TOKEN>` | `200 {totals, by_variant_price:[{variant, price, views, signups, conversion}], by_utm_source, downloads?:{total, by_platform:{"mac-arm64":n,…}, by_version, since}}` — no emails · `401` · `404` if the token is unset · `429` |
| `POST /v1/releases/upload?name=<file>` | GitHub Actions OIDC (`aud` `airbridge-releases`; repository, ref and `workflow_ref` = `desktop-build.yml` checked) | raw body, streamed to `<RELEASES_DIR>/<version>-<sha7>/<file>` (≤ 400 MB; names `AirBridge-Pro-<semver>-<mac-arm64\|mac-x64\|win-x64>.<dmg\|exe>` only) → `201 {id, name, size, sha256, url}` · `400 bad_name` · `401 {reason}` · `409 already_published` · `413` |
| `POST /v1/releases/publish` | same OIDC | `{version}` → `200` manifest, also written to `latest.json` (served at `/downloads/latest.json`); keeps 3 releases |
| `POST /v1/releases/rollback` | `Authorization: Bearer <WAITLIST_ADMIN_TOKEN>` | `{id}` (a kept release, e.g. `0.2.0-abcdef0`) → `200` manifest; `latest.json` points at it |
| `GET /v1/downloads/count` | Caddy `forward_auth` only (404 at the edge) | always `200`; counts a full GET (or first range) of an installer once per client + file per 10 min |
| `POST /v1/deploy` | GitHub Actions OIDC (`aud` `airbridge-deploy`, `workflow_ref` = `server-deploy.yml`) | `202 {commit}`: writes `DEPLOY_DIR/request.json` with the token's `sha`; the droplet's `airbridge-autodeploy` deploys it |
| `GET /v1/deploy/status` | – | `{commit, state, requested, finished_at}` (`deployed`, `deploying`, `failed-restored`, …) |
| `GET /v1/waitlist/export` | `Authorization: Bearer <WAITLIST_ADMIN_TOKEN>` | `200 text/csv` `ts,email,variant,price,referrer,utm_source,utm_medium,utm_campaign,repeats` · `401` · `404` · `429` |
| `POST /v1/admin/smoke/keys`, `POST /v1/admin/smoke/cleanup` | `Authorization: Bearer <WAITLIST_ADMIN_TOKEN>` | **Temporary deploy smoke test only** (`SMOKE_TEST=1`, needs Headscale; 404 otherwise, after `SMOKE_TEST_UNTIL`, and for good once cleanup has run). Keys: throwaway `smoke-<hex>` user + 2 single-use 10-min keys. Cleanup: deletes `smoke-*` users and their nodes. See `src/smoke.ts`, `deploy/digitalocean/README.md`. |

### Waitlist (landing-page demand test)

* **Validation.** `email`: trimmed + lowercased, ≤254 chars, RFC-ish (`local@label.label`, alphabetic TLD).
  `variant` ∈ `private|cross|bridge|current`, `price` ∈ `8|15` (number or numeric string) — invalid → 400.
  `utm_*` must match `[A-Za-z0-9._-]{1,64}` and `referrer` is reduced to its `http(s)` origin (≤200 chars);
  invalid optional fields are stored as `null` rather than losing the sign-up.
* **Abuse.** Non-empty `company` (hidden honeypot) → `200 {ok:true}`, nothing stored (counted in
  `totals.honeypot_since_boot`). Sign-ups: 5/hour per client IP (every attempt counts) and 2000/day globally;
  views: 60/hour per IP, 50 000/day globally. A request whose `Origin` is present and differs from
  `PUBLIC_BASE_URL`'s origin (or that carries `Sec-Fetch-Site: cross-site`) → 403; clients without `Origin` (curl)
  are allowed. Bodies are capped at 4 KiB. No CORS headers are sent.
* **Idempotency.** One record per email: the first touch (variant, price, referrer, utm) is kept; later
  submissions are appended as `repeat` lines and counted (`repeats` in the export, `repeat_submissions` in stats).
  The response is identical for new and repeat emails, so the list cannot be enumerated.
* **Storage.** Append-only JSONL at `WAITLIST_PATH` (default `/data/waitlist/waitlist.jsonl`; directory 0700,
  file 0600). Each event is one `write(2)` of one complete line on an `O_APPEND` descriptor:
  `{"kind":"signup","ts","email","variant","price","referrer","utm_source","utm_medium","utm_campaign"}`,
  `{"kind":"repeat","ts","email","variant","price"}`, `{"kind":"view","ts","variant","price"}` (views carry no
  PII — not even the IP). The file is replayed into memory at boot; a torn last line from a crash is skipped.
  Emails are never logged and never appear in a response other than the authenticated CSV export.
  The file store needs a persistent disk (Railway volume); on Vercel these endpoints answer 503.
* **Admin.** `stats`/`export` compare the bearer token in constant time (SHA-256 of both sides +
  `timingSafeEqual`), are rate limited (10/min per IP) and answer 404 while `WAITLIST_ADMIN_TOKEN` is unset.
  The CSV quotes every cell and prefixes cells starting with `= + - @` with `'` (spreadsheet formula injection).

### Private network (Headscale)

One Headscale user per customer, named `u-<first 20 hex of sha256(clerk sub)>` — no email or Clerk id is sent
to Headscale. `preauth-key` (entitled users only) ensures that user exists (`GET /api/v1/user?name=` →
`POST /api/v1/user`; Headscale reports a concurrent duplicate as HTTP 500, so a failed create is followed by
one re-GET) and creates a **single-use, non-ephemeral** key expiring after `PREAUTH_TTL_SECONDS` (600 s).
Rate limits (per process): 5/min per user, 1000/day globally, 60/min per IP. Keys are never logged.
Headscale errors become `502 {error:"upstream_unavailable"}`; upstream bodies are never forwarded or logged.
Keys are never created with ACL tags.

**Preview mode (`ENFORCE_ENTITLEMENT=false`, PHASE3_PLAN.md §8).** Until the product owner approves the app,
the subscription check on `preauth-key` can be switched off: any Clerk-authenticated user gets a key, and the
would-be refusal is logged as `ENTITLEMENT_NOT_ENFORCED` (`{hsUser, status, wouldBe: 402}`; no Clerk id, no key).
Authentication, rate limits and the policy guard still apply. `/v1/license/verify` is unaffected (still 402
without a subscription). Default is `true`; remove the variable (or set `true`) at launch.

**Policy guard (PHASE3_SECURITY F-1).** Headscale treats an empty or missing policy as allow-all, and the app's
userspace `tailscaled` forwards inbound connections to localhost. So the server reads `GET /api/v1/policy` at
boot, every 10 minutes, and whenever its cached result is stale (serverless hosts have no timers). It
compares that policy semantically to
`{"acls":[{"action":"accept","proto":"tcp","src":["autogroup:member"],"dst":["autogroup:self:8989"]}]}`.
If the policy differs or cannot be read, `preauth-key` answers `503` and `NETWORK_POLICY_MISMATCH` /
`NETWORK_POLICY_UNVERIFIABLE` is logged at error level. A failed check is retried at most every 30 s.

When a webhook moves a subscription to `canceled` or `unpaid` (`incomplete_expired` maps to `canceled`), all of
that user's Headscale nodes are deleted. This is best-effort: failures are logged and the webhook still
succeeds. `past_due` (Stripe's dunning window) and `incomplete` leave existing devices in place, though
`preauth-key` still answers 402 for them. Re-subscribing re-enrolls the devices automatically the next time
the app starts.

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
| `HOST` | Listen address, default `0.0.0.0` (`127.0.0.1` behind a co-located proxy, e.g. `deploy/railway`). |
| `HEADSCALE_URL` | Where this server reaches the Headscale admin REST API over a **private** network, e.g. `http://headscale:8080` on the compose `control` network. Allowed forms: `https://`, or `http://` to localhost or a single-label internal service name. Never the public site: Caddy returns 404 for `/api/*`. If this and the next two are all unset, `/v1/network/*` answer 503. |
| `HEADSCALE_API_KEY` | **Secret.** `headscale apikeys create --expiration 90d` (see `headscale/README.md` for rotation). |
| `HEADSCALE_PUBLIC_URL` | Public login server URL clients enroll with (Headscale `server_url`), e.g. `https://hs.example.com`. |
| `PREAUTH_TTL_SECONDS` | Pre-auth key lifetime, default `600` (60 … 3600). |
| `WAITLIST_PATH` | Absolute path of the waitlist JSONL file, default `/data/waitlist/waitlist.jsonl` (created 0700/0600). If it cannot be opened the server still boots; `/v1/waitlist*` answer 503 and retry on each request. |
| `WAITLIST_ADMIN_TOKEN` | **Secret.** Bearer token for `/v1/waitlist/stats` and `/export`, 32–256 chars `[A-Za-z0-9._~+/=-]` (`openssl rand -hex 32`). Unset → those endpoints answer 404. |
| `ENFORCE_ENTITLEMENT` | `true` (default) or `false`. `false` = preview mode: `/v1/network/preauth-key` skips the subscription (402) check and logs `ENTITLEMENT_NOT_ENFORCED`; auth and rate limits unchanged. `/v1/license/verify` is never affected. Must be `true` at launch. With `false`, the `STRIPE_*` and/or `CLERK_*` groups may be left entirely unset (preview without accounts): billing endpoints then answer `503 billing_not_configured`, authenticated endpoints `503 auth_not_configured`, and `DATABASE_URL` is optional without Stripe. |

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
