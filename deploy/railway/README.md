# AirBridge cloud on Railway (preview)

One Railway service, `airbridge-cloud`, built from this repo with `deploy/railway/Dockerfile` (context = repo root):

| Process | Listens | Public via Caddy on `$PORT` |
|---|---|---|
| Caddy 2.10.2 | `:$PORT` (8080, plain HTTP; Railway's edge terminates TLS) | — |
| license server | `127.0.0.1:8787` | `/v1/*`, `/healthz`, `/checkout/*` |
| Headscale v0.29.7 | `127.0.0.1:8081` (gRPC/metrics loopback) | everything else: `/ts2021`, `/derp`, `/key`, `/machine`, `/register`, `/health`, … |
| — | — | `/api*`, `/swagger*` → **404** (PHASE3_SECURITY F-3) |

* State: Railway volume at `/data` — `headscale/` (SQLite DB, noise + DERP private keys) and `secrets/` (the
  Headscale admin API key, 0600, created by `entrypoint.sh` over the local unix socket, never logged, rotated
  after 60 days with a 90-day expiry). **Back the volume up; losing the keys forces every device to re-enroll.**
* Policy: `license-server/headscale/policy.hujson`, copied unchanged; the license server verifies it at boot.
* DERP: embedded region 999 at `https://<domain>/derp`. Railway has no public UDP, so STUN is loopback-only and
  devices on different networks always relay through this DERP (accepted for the preview).
* If any process exits the container exits non-zero (restart policy `ON_FAILURE`).

## Variables (Railway service variables)

`NODE_ENV=production`, `PORT=8080`, `ENFORCE_ENTITLEMENT=false` (preview), `PREAUTH_TTL_SECONDS=600`,
`PUBLIC_BASE_URL=https://<domain>`, `LICENSE_KEY_ID`, `LICENSE_SIGNING_KEY_PEM` (secret).
`HEADSCALE_*`, `HOST`, `TRUST_PROXY*` are set by the entrypoint. With `ENFORCE_ENTITLEMENT=false` and no
`STRIPE_*` / `CLERK_*`, billing endpoints answer `503 billing_not_configured` and authenticated endpoints
`503 auth_not_configured`. Add the three `CLERK_*` variables to enable sign-in and pre-auth keys; add the
`STRIPE_*` variables plus a Postgres `DATABASE_URL` for billing (with `ENFORCE_ENTITLEMENT=true` all are required).

## Smoke-test hooks (temporary, unset by default)

* `SMOKE_TEST_USER=smoke-<x>` (+ `SMOKE_KEYS=1..5`): on boot, ensure that Headscale user and print single-use
  15-minute pre-auth keys to the deploy log as `SMOKE_KEY=…`.
* `SMOKE_TEST_USER=smoke-<x>` + `SMOKE_CLEANUP=1`: delete that user's nodes and the user instead.
* Remove both variables afterwards. `deploy/railway/smoke/` is a throwaway client image (two real sidecars +
  daemons) used to verify enrollment, DERP relay and `/send_task` through Railway's edge.
