#!/usr/bin/env bash
# AirBridge cloud (Railway, single container): license server + static landing page behind Caddy.
#
#   Railway edge (TLS, 443) -> Caddy :$PORT -> /v1/*, /healthz, /checkout/* -> license server 127.0.0.1:8787
#                                           -> /api*, /swagger*              -> 404
#                                           -> everything else               -> /srv/landing (static files)
#
# No Headscale: Railway's edge strips non-WebSocket Upgrade headers (Tailscale /ts2021 and DERP cannot work), so
# HEADSCALE_* are forced unset and /v1/network/* answer 503 ("not configured"). See README.md.
# State: the Railway volume at /data holds /data/waitlist/waitlist.jsonl (landing-page sign-ups, contains emails).
# If any child process exits, the container exits non-zero so Railway restarts it (ON_FAILURE).
set -euo pipefail

log() { printf '{"level":"%s","msg":"%s","component":"entrypoint"}\n' "$1" "$2"; }
die() { log error "$1"; exit 1; }

DOMAIN="${PUBLIC_DOMAIN:-${RAILWAY_PUBLIC_DOMAIN:-}}"
[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ ]] || die "RAILWAY_PUBLIC_DOMAIN missing or invalid: generate a domain for this service"
export PORT="${PORT:-8080}"
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" != 8787 ] || die "PORT must be numeric and not 8787"

RUN_AS=(setpriv --reuid=node --regid=node --init-groups --inh-caps=-all)

# --- filesystem ----------------------------------------------------------------------------------
WAITLIST_PATH="${WAITLIST_PATH:-/data/waitlist/waitlist.jsonl}"
[[ "$WAITLIST_PATH" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "WAITLIST_PATH must be an absolute path"
install -d -m 0700 -o node -g node "$(dirname "$WAITLIST_PATH")"
if [ -e "$WAITLIST_PATH" ]; then chown node:node "$WAITLIST_PATH" && chmod 0600 "$WAITLIST_PATH"; fi

PIDS=()
cleanup() {
  trap - TERM INT
  for p in "${PIDS[@]}"; do kill -TERM "$p" 2>/dev/null || true; done
  wait || true
}
trap 'cleanup; exit 0' TERM INT

# --- license server ------------------------------------------------------------------------------
(
  unset HEADSCALE_URL HEADSCALE_API_KEY HEADSCALE_PUBLIC_URL
  export WAITLIST_PATH HOST=127.0.0.1 PORT=8787 TRUST_PROXY=1 TRUST_PROXY_HOPS="${TRUST_PROXY_HOPS:-2}"
  export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://${DOMAIN}}"
  cd /app/license-server
  exec "${RUN_AS[@]}" node dist/server.js
) &
PIDS+=($!)

# --- caddy (public, plain HTTP on $PORT) ----------------------------------------------------------
(
  # Caddy never sees the license server's secrets.
  exec env -i PATH="$PATH" PORT="$PORT" HOME=/tmp XDG_DATA_HOME=/tmp/caddy-data XDG_CONFIG_HOME=/tmp/caddy-config \
    "${RUN_AS[@]}" caddy run --config /etc/airbridge/Caddyfile --adapter caddyfile
) &
PIDS+=($!)

log info "started"
set +e
wait -n "${PIDS[@]}"
code=$?
log error "a child process exited (code ${code}); stopping the container so Railway restarts it"
cleanup
exit 1
