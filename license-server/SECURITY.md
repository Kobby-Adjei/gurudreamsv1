# License server security

The license server turns "this Clerk user has an active Stripe subscription" into a short-lived
Ed25519-signed license token that the AirBridge Pro desktop app checks offline. Full Phase-2
threat model: `airbridge/docs/PHASE2_SECURITY.md`. Contract: `airbridge/docs/PHASE2_PLAN.md` §2.

## Endpoints and their guards

| Endpoint | Caller | Guard |
|---|---|---|
| `POST /v1/stripe/webhook` | Stripe | `stripe-signature` verified with `stripe.webhooks.constructEvent` on the **raw** body (300 s tolerance), body size cap, idempotent on `event.id`, subscription state re-fetched from the Stripe API |
| `POST /v1/license/verify` | Desktop app | `Authorization: Bearer <Clerk JWT>` verified against the instance JWKS with `iss` + `aud`, alg allowlist, `sub` must look like `user_…`; per-IP rate limit |
| `POST /v1/billing/checkout` | Desktop app | Same Clerk auth; Checkout Session carries `client_reference_id` and `metadata.clerk_user_id` from the **verified** token, never from the request body |
| `GET /healthz` | Load balancer | Returns no internal state |

## STRIDE

| # | Threat | Control |
|---|---|---|
| S1 | Forged Stripe webhook marks a user active | HMAC signature check (`STRIPE_WEBHOOK_SECRET`); state is taken from `stripe.subscriptions.retrieve`, not from the event body |
| S2 | Forged/foreign Clerk token | JWKS signature, `iss` = `CLERK_ISSUER`, `aud` ∈ `CLERK_AUDIENCE`, `exp` required, small clock tolerance |
| S3 | Paying for someone else / binding a subscription to another user | `clerk_user_id` is set server-side from the authenticated `sub` at checkout creation |
| T1 | Edit a license token | Ed25519 signature; desktop `verify.ts` pins `alg`, `typ`, `kid` and the key type |
| T2 | Out-of-order webhooks downgrade state | Live re-fetch + `last_event_created` ordering in the store; an old subscription ending can't revoke a newer active one |
| R1 | Disputes ("I paid but it says inactive") | Structured logs with `event.id`, subscription id and resulting status (no PII beyond the Clerk user id) |
| I1 | Secret leakage | All secrets from env / platform secret store; `.env` and `*.pem` git-ignored; `.env.example` placeholders only (enforced by `desktop/tests/secrets-scan.test.ts`); errors return generic codes; `Cache-Control: no-store`, `nosniff`, `Referrer-Policy: no-referrer` |
| I2 | Account enumeration | `/verify` answers only for the authenticated caller |
| D1 | Request floods | Per-IP limits on `/verify` and `/checkout`; webhook body cap |
| E1 | Signing key theft | Key only in the secret store; never logged; rotate via a new `LICENSE_KEY_ID` while the desktop ships both public keys |

## Operational requirements

1. **Signing key.** Generate with `npm run keys:generate` on a trusted machine. Store the PKCS8
   PEM only in the host's secret manager as `LICENSE_SIGNING_KEY_PEM`; put the public PEM into the
   desktop release build (`MAIN_VITE_AIRBRIDGE_LICENSE_PUBKEYS`). Delete the local copy. Never paste
   it into CI logs or tickets.
2. **Stripe.** Use a restricted key (`rk_…`) limited to Checkout Sessions, Customers,
   Subscriptions (read) and Billing Portal. Separate test/live webhook secrets. Subscribe the
   endpoint only to `checkout.session.completed` and `customer.subscription.{created,updated,deleted}`.
3. **Clerk.** OAuth application with PKCE; register only the app's `airbridge://` callback URI.
   `CLERK_AUDIENCE` = that application's client id.
4. **Database.** TLS to Postgres, least-privilege role (no DDL at runtime; run `npm run migrate`
   separately). The in-memory store is refused when `NODE_ENV=production`.
5. **Proxy.** Set `TRUST_PROXY=1` only behind a proxy that overwrites `X-Forwarded-For`; see
   finding F1 below.
6. **HTTPS only**, HSTS at the edge, `PUBLIC_BASE_URL` set explicitly so redirect URLs never come
   from request headers.

## Review findings (Phase 2 security review)

| ID | Severity | Finding | Suggested fix |
|---|---|---|---|
| F1 | Low–Medium | `src/app.ts` `clientIp`: with `trustProxy`, the **leftmost** `X-Forwarded-For` entry is used. That entry is client-controlled, so rate limits can be bypassed by sending a random XFF value | Use the entry appended by the trusted proxy (rightmost, or `rightmost - (hops-1)`), or the platform's own client-IP header |
| F2 | Low | `baseUrl()` falls back to `X-Forwarded-Host` when `PUBLIC_BASE_URL` is unset. Only the caller's own Checkout redirect is affected, but production should not depend on request headers | Require `PUBLIC_BASE_URL` when `NODE_ENV=production` |
| F3 | Info | Webhook idempotency check (`hasProcessedEvent`) and `markEventProcessed` are not atomic; concurrent duplicate deliveries are both processed. Harmless today because processing re-fetches live state | Keep handlers idempotent, or insert the event id first with `ON CONFLICT DO NOTHING` |

## Sign-off

- [x] Token format matches the desktop verifier (`alg EdDSA`, `typ airbridge-license+jwt`, `kid`, string `aud`, integer `iat`/`exp`)
- [x] Webhook signature on raw body, idempotent, state re-fetched
- [x] Clerk JWT verified with iss/aud/JWKS
- [x] No secrets committed (`desktop/tests/secrets-scan.test.ts`)
- [ ] F1 fixed or `TRUST_PROXY` documented as single trusted hop
- [ ] Production `PUBLIC_BASE_URL` required
- [ ] Deployed behind HTTPS with secrets in the platform store
