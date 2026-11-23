# AirBridge private network: Headscale deployment kit

AirBridge's "Invisible Network" uses a **self-hosted [Headscale](https://github.com/juanfont/headscale) v0.29.7**
control server. Each AirBridge customer gets their own Headscale user (`u-<sha256(clerk sub)[:20]>`). The policy
only lets a customer's devices reach each other, and only on the AirBridge inbox port. The desktop app ships
its own `tailscaled` in userspace mode and enrolls with single-use pre-auth keys from the license server
(`POST /v1/network/preauth-key`). End users never install or see Tailscale.

| File | Purpose |
|---|---|
| `docker-compose.yml` | `headscale/headscale:v0.29.7` + Caddy 2 (automatic Let's Encrypt TLS) |
| `config.yaml.tmpl` | Headscale config: embedded DERP + STUN, **no Tailscale public DERP**, no MagicDNS, nodes never expire, SQLite |
| `policy.hujson` | ACL: `autogroup:member` → `autogroup:self:8989` only |
| `Caddyfile` | TLS, HTTP→HTTPS, and `/api/*` limited to the license server's IPs |

Verified against v0.29.7: the rendered config passes `headscale configtest`; `headscale policy check` accepts the
policy (and rejects a malformed port, so the check is real). The REST calls the license server makes were run
against a live v0.29.7 server, including a full enroll with the bundled `tailscaled`.

## Why the policy looks like this

```hujson
{"acls":[{"action":"accept","src":["autogroup:member"],"dst":["autogroup:self:8989"]}]}
```

* `autogroup:self` limits each user to their own devices, so customers are isolated from each other. In v0.29.7
  it is valid only with user, group, `autogroup:member` or `*` sources. Tagged sources are rejected.
* **The `:8989` port restriction is security-critical.** In userspace mode, `tailscaled` forwards inbound tailnet
  connections to `127.0.0.1:<port>`. Without the port restriction, any localhost service on a customer's
  machine (databases, dev servers) would be reachable from their other devices. Do not widen it.
* Anything not explicitly allowed is denied.

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
2. **Firewall**: allow inbound **80/tcp** (ACME + redirect), **443/tcp** (control plane, DERP relay, REST API) and
   **3478/udp** (STUN). Nothing else. Headscale's 8080, metrics (9090) and gRPC (50443) are never published.
3. **Files**:
   ```bash
   git clone <this repo> && cd license-server/headscale
   mkdir -p config data
   export HEADSCALE_DOMAIN=hs.example.com PUBLIC_IPV4=203.0.113.10 PUBLIC_IPV6=   # IPv6 may stay empty
   envsubst '${HEADSCALE_DOMAIN} ${PUBLIC_IPV4} ${PUBLIC_IPV6}' < config.yaml.tmpl > config/config.yaml
   cat > .env <<EOF
   HEADSCALE_DOMAIN=hs.example.com
   ACME_EMAIL=ops@example.com
   # Space-separated egress IPs/CIDRs of the license server. Only these may call /api/*.
   LICENSE_SERVER_IPS=198.51.100.7
   EOF
   chmod 600 .env
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
   Put the printed `hskey-api-…` into the license server's secret store as `HEADSCALE_API_KEY`, and set
   `HEADSCALE_URL=https://hs.example.com`, `HEADSCALE_PUBLIC_URL=https://hs.example.com`. It is shown once.
   Never commit it.
6. **Smoke test** from the license server host:
   `curl -H "Authorization: Bearer $HEADSCALE_API_KEY" https://hs.example.com/api/v1/user` should return
   `{"users":[...]}`. The same request from any other IP should return 404.

### License-server egress IPs

`/api/*` is only reachable from `LICENSE_SERVER_IPS`. Hosts with stable egress IPs (Railway static outbound IPs,
Fly.io egress IPs, a VM) work as-is. Serverless hosts with rotating egress (Vercel) need a static-egress add-on,
or run the license server on the Headscale VM: uncomment the `127.0.0.1:8080:8080` port in
`docker-compose.yml` and set `HEADSCALE_URL=http://127.0.0.1:8080`. Plain HTTP is accepted for localhost only.
The API key is still required either way.

## API key rotation

Keys created with `--expiration 90d` stop working after 90 days. Rotate every ~60 days:

```bash
docker compose exec headscale headscale apikeys create --expiration 90d   # 1. new key
#   2. update HEADSCALE_API_KEY in the license server's secrets and redeploy it
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
