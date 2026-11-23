# AirBridge private network: Headscale deployment kit

AirBridge's "Invisible Network" uses a **self-hosted [Headscale](https://github.com/juanfont/headscale) v0.29.7**
control server. Each AirBridge customer gets their own Headscale user (`u-<sha256(clerk sub)[:20]>`). The policy
only lets a customer's devices reach each other, and only on the AirBridge inbox port. The desktop app ships
its own `tailscaled` in userspace mode and enrolls with single-use pre-auth keys from the license server
(`POST /v1/network/preauth-key`). End users never install or see Tailscale.

| File | Purpose |
|---|---|
| `docker-compose.yml` | `headscale/headscale:v0.29.7` + Caddy 2 (automatic Let's Encrypt TLS) + the license server on an internal network |
| `config.yaml.tmpl` | Headscale config: embedded DERP + STUN, **no Tailscale public DERP**, no MagicDNS, nodes never expire, SQLite |
| `policy.hujson` | ACL: `autogroup:member` → `autogroup:self:8989`, TCP only |
| `Caddyfile` | TLS and HTTP→HTTPS. `/api/*` and `/swagger*` always return **404** on the public site |

Verified against v0.29.7: the rendered config passes `headscale configtest`; `headscale policy check` accepts the
policy (and rejects a malformed port, so the check is real). The REST calls the license server makes were run
against a live v0.29.7 server, including a full enroll with the bundled `tailscaled`.

## Why the policy looks like this

```hujson
{"acls":[{"action":"accept","proto":"tcp","src":["autogroup:member"],"dst":["autogroup:self:8989"]}]}
```

* `autogroup:self` limits each user to their own devices, so customers are isolated from each other. In v0.29.7
  it is valid only with user, group, `autogroup:member` or `*` sources. Tagged sources are rejected.
* **The `:8989` port restriction is security-critical.** In userspace mode, `tailscaled` forwards inbound tailnet
  connections to `127.0.0.1:<port>`. Without the port restriction, any localhost service on a customer's
  machine (databases, dev servers) would be reachable from their other devices. Do not widen it.
* `"proto": "tcp"`: the inbox is HTTP, so no UDP or ICMP.
* Anything not explicitly allowed is denied. **Headscale treats an empty or missing policy as allow-all.**
  Because of that, the license server checks the live policy (`GET /api/v1/policy`) at boot, every
  10 minutes, and whenever its cached result is stale. It compares the policy semantically to the
  policy above. If the policy differs or cannot be read, it **stops issuing pre-auth keys** (`503`) and logs
  `NETWORK_POLICY_MISMATCH` / `NETWORK_POLICY_UNVERIFIABLE` at error level. Alert on those log lines.
* Pre-auth keys never carry ACL tags. A tagged node would fall outside `autogroup:self`.

The policy is loaded from file (`policy.mode: file`). After you edit it, check it and restart Headscale:

```bash
docker compose exec headscale headscale policy check --file /etc/headscale/policy.hujson
docker compose restart headscale
```

## Deploy

Requirements: a small Linux VM (1 vCPU / 1 GB RAM is plenty to start) with a **static public IPv4** (IPv6
optional), Docker with the compose plugin, and a DNS name such as `hs.example.com`.

1. **DNS**: create an `A` record (and an `AAAA` record if you have IPv6) for `hs.example.com` pointing at the VM.
   Do not proxy it through Cloudflare's orange cloud: it breaks the Tailscale control protocol and DERP.
2. **Firewall**: allow inbound **80/tcp** (ACME + redirect), **443/tcp** (control plane and DERP relay) and
   **3478/udp** (STUN). Nothing else. Headscale's 8080, metrics (9090) and gRPC (50443, bound to the
   container's loopback) are never published. The admin REST API is **not** served publicly: Caddy returns 404
   for `/api/*` and `/swagger*`.
3. **Files**:
   ```bash
   git clone <this repo> && cd license-server/headscale
   mkdir -p config data
   export HEADSCALE_DOMAIN=hs.example.com PUBLIC_IPV4=203.0.113.10 PUBLIC_IPV6=   # IPv6 may stay empty
   envsubst '${HEADSCALE_DOMAIN} ${PUBLIC_IPV4} ${PUBLIC_IPV6}' < config.yaml.tmpl > config/config.yaml
   cat > .env <<EOF
   HEADSCALE_DOMAIN=hs.example.com
   ACME_EMAIL=ops@example.com
   EOF
   cp ../.env.example license-server.env     # fill in Stripe/Clerk/license values; HEADSCALE_URL/PUBLIC_URL are set by compose
   chmod 600 .env license-server.env
   ```
   (`envsubst` comes from the `gettext-base` package.)
4. **Start**:
   ```bash
   docker compose up -d
   docker compose logs -f headscale          # "listening and serving HTTP on: 0.0.0.0:8080"
   curl https://hs.example.com/health        # {"status":"pass"}
   ```
   If headscale cannot write `./data`, run `sudo chown -R 65532:65532 data` (the image runs as a non-root user)
   and start it again.
5. **API key** for the license server (see rotation below):
   ```bash
   docker compose exec headscale headscale apikeys create --expiration 90d
   ```
   Put the printed `hskey-api-…` into `license-server.env` as `HEADSCALE_API_KEY` and run
   `docker compose up -d license-server`. The key is shown only once. Never commit it.
6. **Smoke test**: `curl https://hs.example.com/api/v1/user` must return **404** from anywhere.
   `docker compose logs license-server | grep network_policy_verified` must show the policy check passing.
   `curl -X POST http://127.0.0.1:8787/v1/network/preauth-key` on the VM should return `401` (not `503`).

### Network layout (why the license server runs next to Headscale)

Headscale API keys are **full admin** credentials, and Headscale serves `/api/v1` on the same listener as the
control protocol. So the API is reachable in only one place: the internal compose network `control`
(`internal: true`, no egress). The license server uses `HEADSCALE_URL=http://headscale:8080` on that network
and reaches Stripe and Clerk through a separate `egress` network. Caddy is only on `edge` and returns 404 for
`/api/*`. The license server listens on `127.0.0.1:8787`. To expose it publicly, add a TLS site in front of it,
for example a second Caddy site block `license.example.com { reverse_proxy license-server:8787 }` with the
`license-server` service also attached to `edge`, and set `TRUST_PROXY=1`.

If the license server must run elsewhere (Railway, Fly, Vercel), connect it to the Headscale VM over a private
network such as WireGuard or a cloud VPC. Point `HEADSCALE_URL` at the private address, using https, or http
with a single-label internal name. **Never re-open `/api/*` on the public site.**

## API key rotation

Keys created with `--expiration 90d` stop working after 90 days. Rotate every ~60 days:

```bash
docker compose exec headscale headscale apikeys create --expiration 90d   # 1. new key
#   2. update HEADSCALE_API_KEY in license-server.env, then: docker compose up -d license-server
#   3. confirm /v1/network/preauth-key works (or the smoke test above)
docker compose exec headscale headscale apikeys list                       # 4. find the old key's prefix
docker compose exec headscale headscale apikeys expire --prefix <old-prefix>
```

If a key leaks, expire it straight away (`apikeys expire --prefix …`) and then deploy a new one.

## Backups

All state is in `./data`: `db.sqlite` (users, nodes, pre-auth keys), `noise_private.key` and
`derp_server_private.key`. **Losing the keys means every device must re-enroll.** Back up `./data`,
`config/config.yaml` and `policy.hujson`:

```bash
# Consistent online snapshot of the SQLite DB (WAL mode), plus the key files:
docker run --rm -v "$PWD/data:/data" -v "$PWD/backup:/backup" alpine:3.22 sh -c \
  'apk add --no-cache sqlite >/dev/null && sqlite3 /data/db.sqlite ".backup /backup/db-$(date +%Y%m%d%H%M).sqlite" \
   && cp /data/*.key /backup/'
```

Run it daily from cron, encrypt the copies and send them off the VM (they contain private keys). Before an
upgrade, also do a cold copy: `docker compose stop headscale && cp -a data data.bak-$(date +%s) && docker compose start headscale`.
**Restore**: stop headscale, put the files back into `./data` and start it again.

## Upgrades

Pin exact versions. Read the Headscale CHANGELOG for breaking config changes. For example, v0.29 made
`randomize_client_port` a fatal config error. Take a backup, change the image tag, then run
`docker compose pull && docker compose up -d`. The desktop app's `tailscaled` (v1.104.7) and Headscale are
versioned separately, so test enrollment on staging first.

## Operations notes

* **No Tailscale-operated infrastructure**: `derp.urls: []` means clients only use the embedded DERP region
  `999 "AirBridge Relay"` (relay over `https://hs.example.com/derp`, STUN on 3478/udp). This makes it a single
  point of failure for users behind NAT. Budget a second DERP region (`derp.paths`) for production.
* `node.expiry: 0`: devices do not expire. Access is removed by the license server instead. When a
  Stripe subscription becomes inactive, the webhook deletes all of that customer's nodes. A user can also remove
  one device through `POST /v1/network/devices/:id/remove`.
* `dns.magic_dns: false`, `override_local_dns: false`: AirBridge never touches the user's DNS.
* Logs are JSON on stdout (`docker compose logs`). Pre-auth keys never appear there: the license server
  creates them through the API and the desktop passes them to `tailscale up` via a 0600 file, never via argv.
