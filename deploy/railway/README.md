# AirBridge cloud on Railway (preview: license server + landing page)

One Railway service, `airbridge-cloud`, built from this repo with `deploy/railway/Dockerfile` (context = repo root):

| Process | Listens | Public via Caddy on `$PORT` |
|---|---|---|
| Caddy 2.10.2 | `:$PORT` (8080, plain HTTP; Railway's edge terminates TLS) | — |
| license server | `127.0.0.1:8787` | `/v1/*` (incl. `/v1/waitlist*`), `/healthz`, `/checkout/*` |
| static files | `/srv/landing` (copied from `landing/` at build time) | everything else: `/`, `/app.js`, `/styles.css`, `/assets/*`, … |
| — | — | `/api*`, `/swagger*` → **404** (kept as a guard) |

## Why there is no Headscale here

Railway's edge only forwards WebSocket upgrades; it strips other `Upgrade` headers. Tailscale's control protocol
(`/ts2021`, `Upgrade: tailscale-control-protocol`) and DERP (`/derp`, `Upgrade: DERP`) therefore cannot work
through it, so Headscale was removed from this image (together with its config template, the admin-API-key
bootstrap and the throwaway smoke-test client). The self-hosted kit is unchanged in `license-server/headscale/`
for a future VM with its own TLS and ports.

The entrypoint force-unsets `HEADSCALE_URL`, `HEADSCALE_API_KEY` and `HEADSCALE_PUBLIC_URL`, so the license
server's `/v1/network/*` endpoints are in their "not configured" **503** state (`auth_not_configured` while Clerk
is unset, otherwise `network_unavailable`). Old Headscale state on the volume (`/data/headscale`, `/data/secrets`)
is no longer read; delete it once the self-hosted server is up (or keep it as a backup until then).

## Landing page and waitlist

* `landing/` is copied into the image (`/srv/landing`, read-only, root-owned). `landing/tools`, `landing/docs`,
  dotfiles and `*.md` are excluded by `Dockerfile.dockerignore`. The build fails if `landing/index.html` is missing.
  Redeploy to publish landing changes.
* Static responses carry `Cache-Control: no-cache` (ETag revalidation), `X-Frame-Options: DENY` and this CSP:
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self';
  connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`.
  **No inline `<script>`, no third-party scripts/fonts/analytics** unless the CSP in `Caddyfile` is changed too.
* The page posts to same-origin `/v1/waitlist` and `/v1/waitlist/view` (API: `license-server/README.md`).
  Cross-origin browser POSTs are refused (403): the allowed Origin is `PUBLIC_BASE_URL`, which the entrypoint
  defaults to `https://$RAILWAY_PUBLIC_DOMAIN`. **With a custom domain, set `PUBLIC_BASE_URL=https://<custom domain>`**
  (one origin only: visitors on the other hostname would get 403 on sign-up).
* Sign-ups and page views are stored in `/data/waitlist/waitlist.jsonl` (dir 0700, file 0600, owned by `node`;
  append-only, one JSON line per event). **This file contains email addresses. It needs the Railway volume
  mounted at `/data`** — without a volume the list is lost on every redeploy. Back it up.
* Founder access (needs `WAITLIST_ADMIN_TOKEN`):

  ```sh
  curl -H "Authorization: Bearer $WAITLIST_ADMIN_TOKEN" https://<domain>/v1/waitlist/stats    # counts + conversion
  curl -H "Authorization: Bearer $WAITLIST_ADMIN_TOKEN" -o waitlist.csv https://<domain>/v1/waitlist/export
  ```

## Variables (Railway service variables)

| Variable | Value |
|---|---|
| `WAITLIST_ADMIN_TOKEN` | **Secret, set this.** ≥32 chars, e.g. `openssl rand -hex 32`. Unset → `/v1/waitlist/stats` and `/export` answer 404. |
| `PUBLIC_BASE_URL` | Optional; defaults to `https://$RAILWAY_PUBLIC_DOMAIN`. Set it when a custom domain is attached. |
| `LICENSE_KEY_ID`, `LICENSE_SIGNING_KEY_PEM` | Required by the license server (secret PEM). Already set on the existing service. |
| `ENFORCE_ENTITLEMENT` | `false` (preview: lets the server boot without Stripe/Clerk). |
| `NODE_ENV`, `PORT` | `production`, `8080` (image defaults). |
| `WAITLIST_PATH` | Optional, default `/data/waitlist/waitlist.jsonl`. |

Set by the entrypoint (do not set): `HOST`, `PORT` (license server), `TRUST_PROXY=1`, `TRUST_PROXY_HOPS=2`.
Remove the obsolete Headscale-era variables if present: `PREAUTH_TTL_SECONDS`, `SMOKE_TEST_USER`, `SMOKE_KEYS`,
`SMOKE_CLEANUP` (harmless but unused). With no `STRIPE_*` / `CLERK_*`, billing endpoints answer
`503 billing_not_configured` and authenticated endpoints `503 auth_not_configured`.

Rate limits (per process, in memory; reset on restart): sign-ups 5/hour per client IP and 2000/day globally;
page views 60/hour per IP and 50 000/day globally; admin endpoints 10/minute per IP.

## Local check

```sh
docker build -f deploy/railway/Dockerfile -t airbridge-railway .
docker run --rm -p 8080:8080 -e RAILWAY_PUBLIC_DOMAIN=localhost -e PUBLIC_BASE_URL=http://localhost:8080 \
  -e ENFORCE_ENTITLEMENT=false -e LICENSE_KEY_ID=dev -e LICENSE_SIGNING_KEY_PEM="$(cat dev.pem)" \
  -e WAITLIST_ADMIN_TOKEN=$(openssl rand -hex 32) airbridge-railway
```

`PUBLIC_BASE_URL=http://…` is only accepted for `localhost`. Behind the sandbox's HTTPS proxy, `npm ci` inside
the build needs the proxy CA and `--network host`; Railway's builder needs neither.
