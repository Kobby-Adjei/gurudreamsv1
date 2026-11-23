# AirBridge cloud on one DigitalOcean droplet

One small droplet runs everything: **Headscale v0.29.7** (control server + embedded DERP relay + STUN), the
**license server**, and the **landing page**, behind **Caddy 2.10.2** with an automatic Let's Encrypt certificate.
It replaces Railway, whose edge strips non-WebSocket `Upgrade` headers so Headscale cannot run there
(`deploy/railway/README.md`). The Railway service is left in place (landing + waitlist) until DNS moves.

| | |
|---|---|
| Droplet | `airbridge-cloud`, nyc3, `s-1vcpu-1gb-intel` (1 vCPU / 1 GiB / 25 GB; the smallest 1 GiB size nyc3 offers), Ubuntu 24.04 LTS, monitoring on, tag `airbridge` |
| Cost | **$7/month**. Optional DigitalOcean weekly backups: +20 % ($1.40/month); daily: +30 % ($2.10/month) |
| Firewall | DO Cloud Firewall `airbridge-cloud-fw` (by tag): in **80/tcp, 443/tcp, 3478/udp, ICMP**. **22/tcp is closed.** |
| Hostname | `<public-ip-with-dashes>.sslip.io` until a domain exists; one setting (`AIRBRIDGE_DOMAIN`) switches it |
| Code | the public GitHub repo at **one pinned commit**, verified on the droplet (`git rev-parse HEAD == commit`) |

## Layout

```
internet ─┬─ 80/443 tcp ─> caddy ─(edge)─┬─> headscale:8080        /ts2021 /key /derp /derp/probe /derp/latency-check /bootstrap-dns /health
          │                              ├─> license-server:8787   /v1/* /healthz /checkout/*
          │                              └─> /srv/landing (static) everything else      /api* /swagger* -> 404
          └─ 3478 udp ──> headscale (STUN)
license-server ─(control: internal network, no egress)─> headscale:8080 /api/v1   (the ONLY path to the admin API)
```

| Path on the droplet | What |
|---|---|
| `/etc/airbridge/airbridge.env` | settings you may edit (domain, Clerk, preview flags). Then `sudo airbridge-bootstrap`. |
| `/etc/airbridge/runtime.env` | generated compose variables (non-secret) |
| `/opt/airbridge/src` | sparse checkout of the pinned commit (`license-server/`, `landing/`, `deploy/digitalocean/`) |
| `/var/lib/airbridge/headscale/` | Headscale `db.sqlite`, `noise_private.key`, `derp_server_private.key` (uid 65532, 0700) |
| `/var/lib/airbridge/secrets/` | `license_signing_key.pem`, `license_key_id`, `headscale_api_key`, `waitlist_admin_token` (0400, uid 1000) |
| `/var/lib/airbridge/license/` | `waitlist/waitlist.jsonl` (emails), `smoke/` |
| `/var/lib/airbridge/site/` | public landing files copied from `landing/` (no `tools/`, `docs/`, `blender/`, dotfiles, `*.md`) |
| `/var/lib/airbridge/caddy/` | ACME account + certificates |
| `/var/lib/airbridge/backups/` | nightly backups (0600) |

Files in this directory:

| File | Purpose |
|---|---|
| `provision.sh` | creates the firewall + droplet via the DO API with cloud-init `user_data` (run from any machine) |
| `cloud-init.yaml.tmpl` | first boot: packages, `airbridge.env`, the waitlist token, fetch + verify the commit, `airbridge-install` |
| `bin/airbridge-install` | host setup (scripts, systemd units, Docker log rotation, journald cap, unattended-upgrades, swap), then bootstrap |
| `bin/airbridge-bootstrap` | idempotent: keys on first run, config render, landing copy, build, start, API key, policy check |
| `bin/airbridge-compose` | `docker compose` for this stack (`sudo airbridge-compose ps`, `logs -f headscale`, …) |
| `bin/airbridge-update <sha>` | deploy another commit (from the DO console) |
| `bin/airbridge-backup`, `bin/airbridge-rotate-apikey`, `bin/airbridge-smoke-off` | nightly backup, monthly API-key rotation, smoke-test shut-off |
| `docker-compose.yml`, `Caddyfile`, `license-server.Dockerfile`, `license-entrypoint.sh` | the stack |
| `smoke/e2e.py` | two real sidecars + daemons against the live server (temporary smoke test) |

Images are pinned by tag **and** digest: `headscale/headscale:v0.29.7@sha256:11f81665…`,
`caddy:2.10.2@sha256:c3d7ee5d…`, `node:22-slim@sha256:e9f565d3…` (license server, built on the droplet).

## Security properties (PHASE3_SECURITY.md)

* **H-1 / F-3**: Caddy answers 404 for `/api`, `/api/*`, `/swagger*` and serves no other Headscale page (`/register`,
  `/apple`, `/windows`, `/version` are not routed). The license server reaches the API only over the `control`
  network (`internal: true`). gRPC and metrics stay on Headscale's container loopback.
* **API key**: created on first boot with the local CLI over the unix socket (`headscale apikeys create
  --expiration 90d`), written straight to a 0400 file, never printed. The license server reads it from a mounted
  file (`license-entrypoint.sh`), so it is not in `docker inspect` or compose files. Rotated monthly by
  `airbridge-rotate-apikey.timer` (new key → restart → policy must verify through it → older keys expired; on
  failure the old key is restored).
* **F-1 policy**: `license-server/headscale/policy.hujson` (exactly
  `{"acls":[{"action":"accept","proto":"tcp","src":["autogroup:member"],"dst":["autogroup:self:8989"]}]}`).
  Bootstrap runs `headscale policy check` and refuses to finish until the license server's PolicyGuard reports
  `verified`. **`GET /healthz` → `{"ok":true,"policy":"verified"}`** is the non-secret readiness signal (`mismatch` /
  `unverifiable` / `pending` mean pre-auth keys are refused).
* **DERP/STUN**: embedded DERP region 999 over `https://<host>/derp`, STUN on 3478/udp, `derp.urls: []` (no
  Tailscale-operated relays).
* **License signing key**: Ed25519, generated on the droplet on first boot, 0400; it never leaves the server except
  inside the local backups. Its public half: **`GET /v1/license/public-key` → `{kid, alg:"EdDSA", pem}`**.
* Containers: `no-new-privileges`, all capabilities dropped (Caddy keeps `NET_BIND_SERVICE`), read-only root
  filesystems, non-root Headscale (65532) and license server (node, 1000). Containers cannot reach the droplet
  metadata service (`airbridge-docker-guard`: `DOCKER-USER -d 169.254.169.254 -j REJECT`).
* **user_data**: DigitalOcean stores it in the droplet metadata; it contains the waitlist admin token (and nothing
  else secret). Only processes on the droplet itself can read it, and containers are blocked. Accepted trade-off.
  To retire it, rotate the token (below).
* Updates: `unattended-upgrades` installs security updates daily and reboots at 08:30 UTC when required; all
  containers are `restart: unless-stopped`, Docker runs with `live-restore`. Docker logs: json-file 10 MB × 5 per
  container; journald capped at 200 MB.

## Deploy (no SSH)

```sh
git push                                     # the commit must be on GitHub (repo is public)
DO_TOKEN=... deploy/digitalocean/provision.sh <40-hex commit> <file with WAITLIST_ADMIN_TOKEN> [smoke-hours]
# -> droplet_id=… ip=… host=<ip-with-dashes>.sslip.io
curl https://<host>/healthz                  # {"ok":true,"policy":"verified"} after ~5-8 min
```

If first boot fails, the droplet serves the last 80 lines of its install log (no secrets) at
`http://<ip>/airbridge-install.txt` (or, when Caddy is already up, `https://<host>/airbridge-install.txt`).

## Operating it without SSH

Port 22 is closed. Emergency access: DigitalOcean control panel → the droplet → **Access → Recovery Console**
(VNC-style, works with the firewall closed; log in as root with the password DigitalOcean e-mailed at creation, or
"Reset root password" on the same page). Useful commands there:

```sh
sudo airbridge-compose ps                    # status
sudo airbridge-compose logs --tail 100 headscale license-server caddy
sudo airbridge-bootstrap                     # re-apply settings (after editing /etc/airbridge/airbridge.env)
sudo airbridge-update <40-hex commit>        # deploy another commit (fetch, verify, install, bootstrap)
sudo airbridge-compose exec headscale headscale nodes list
```

For a longer session you can temporarily add an SSH key in the panel and a firewall rule for **your IP only** on
22/tcp; remove both afterwards.

### Switching to a real domain

1. Create an `A` record `airbridge.example.com → <droplet IP>` (no Cloudflare proxying).
2. Console: set `AIRBRIDGE_DOMAIN=airbridge.example.com` in `/etc/airbridge/airbridge.env`, run `sudo airbridge-bootstrap`.
   Caddy gets a certificate; Headscale's `server_url`, `PUBLIC_BASE_URL` and `HEADSCALE_PUBLIC_URL` follow.
3. Desktop builds must ship the new login-server/license URL. Devices enrolled against the sslip.io name keep that
   name in their state: keep the old name working (both names can be served by adding the old name to the
   Caddyfile site address) until all devices have re-enrolled, or re-enroll them.

## Waitlist

Same API as on Railway (`license-server/README.md`). The admin token is the existing `WAITLIST_ADMIN_TOKEN`:

```sh
curl -H "Authorization: Bearer $WAITLIST_ADMIN_TOKEN" https://<host>/v1/waitlist/stats
curl -H "Authorization: Bearer $WAITLIST_ADMIN_TOKEN" -o waitlist.csv https://<host>/v1/waitlist/export
```

Rotate the token: console → `openssl rand -hex 32 | sudo tee /var/lib/airbridge/secrets/waitlist_admin_token >/dev/null`
(keep owner 1000, mode 0400) → `sudo airbridge-compose up -d --force-recreate license-server`.

## Backups

`airbridge-backup.timer` runs nightly at 07:15 UTC and writes `/var/lib/airbridge/backups/airbridge-<UTC>.tar.gz`
(0600, last 14 kept): an online SQLite backup of Headscale's DB (integrity-checked), Headscale's noise + DERP keys,
rendered config + policy, the waitlist (emails), all four secrets and `airbridge.env`. Run one now:
`sudo airbridge-backup`.

These files contain private keys, so they stay on the droplet. Getting one off the server:

* Simplest off-site copy: enable **DigitalOcean Backups** for the droplet (+$1.40/month weekly). It snapshots the
  whole disk, including `/var/lib/airbridge/backups`.
* Download one file: temporarily allow 22/tcp from your IP + add your SSH key, then
  `scp root@<ip>:/var/lib/airbridge/backups/airbridge-<stamp>.tar.gz .`, and remove the rule again. Store it
  encrypted (it holds the license signing key and Headscale's private keys).
* The waitlist alone (emails) is always downloadable over HTTPS with `/v1/waitlist/export` (above).

Restore: stop the stack (`airbridge-compose down`), put the files back in place (paths in the table above; keep the
owners 65532 / 1000), `sudo airbridge-bootstrap`.

## End-to-end smoke test (temporary)

`provision.sh … <smoke-hours>` sets `SMOKE_TEST=1` and `SMOKE_TEST_UNTIL`. The license server then exposes
admin-only `POST /v1/admin/smoke/keys` (bearer = waitlist admin token; a throwaway Headscale user `smoke-<hex>` + 2
single-use 10-minute keys, returned once, at most 3 calls) and `POST /v1/admin/smoke/cleanup` (deletes every
`smoke-*` user and its nodes, then writes a marker). From any Linux machine with this repo:

```sh
desktop/scripts/build-net.sh linux/amd64             # if desktop/resources/net/linux-x64/airbridge-net is missing
python3 -m venv /tmp/abvenv && /tmp/abvenv/bin/pip install -r airbridge/requirements.txt
/tmp/abvenv/bin/python deploy/digitalocean/smoke/e2e.py --base https://<host> --token-file <token file> \
  --python /tmp/abvenv/bin/python --cleanup
```

It enrolls two sidecars, waits for `connected`, checks that each sees the other in `/nodes`, delivers tasks both
ways through the real daemons (`/send_task` → sidecar `/send` → mesh `:8989` → peer inbox), then cleans up. The
cleanup marker makes the endpoints 404 at once; `airbridge-smoke-off.path` then sets `SMOKE_TEST=0` and restarts
the license server, and `airbridge-smoke-off.timer` does the same after `SMOKE_TEST_UNTIL` in any case.
