#!/usr/bin/env bash
# AirBridge cloud (Railway, single container): Headscale v0.29.7 + license server + Caddy.
#
#   Railway edge (TLS, 443) -> Caddy :$PORT -> /v1/*, /healthz, /checkout/*  -> license server 127.0.0.1:8787
#                                           -> /api*, /swagger*               -> 404 (PHASE3_SECURITY F-3)
#                                           -> everything else                -> headscale 127.0.0.1:8081
#
# State lives on the Railway volume at /data (headscale DB + noise/DERP keys, the admin API key).
# The Headscale admin API key is created here through the local unix socket, stored 0600 on /data,
# handed to the license server through its environment and NEVER printed.
# If any child process exits, the container exits non-zero so Railway restarts it (ON_FAILURE).
#
# Temporary smoke-test hooks (unset by default; see deploy/railway/README.md):
#   SMOKE_TEST_USER=smoke-<x>  ensure that Headscale user and print SMOKE_KEYS (1-5, default 1)
#                              single-use pre-auth keys (15 min) to the deploy log as "SMOKE_KEY=<key>".
#   SMOKE_CLEANUP=1            with SMOKE_TEST_USER: delete that user's nodes and the user; print no keys.
set -euo pipefail

log() { printf '{"level":"%s","msg":"%s","component":"entrypoint"}\n' "$1" "$2"; }
die() { log error "$1"; exit 1; }

DOMAIN="${PUBLIC_DOMAIN:-${RAILWAY_PUBLIC_DOMAIN:-}}"
[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ ]] || die "RAILWAY_PUBLIC_DOMAIN missing or invalid: generate a domain for this service"
export PORT="${PORT:-8080}"
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" != 8081 ] && [ "$PORT" != 8787 ] || die "PORT must be numeric and not 8081/8787"

RUN_AS=(setpriv --reuid=node --regid=node --init-groups --inh-caps=-all)
HS_CONF=/run/airbridge/headscale.yaml
# Headscale reads HEADSCALE_* env as config overrides: run it (and its CLI) with a minimal environment.
HS=(env -i PATH="$PATH" HOME=/tmp headscale -c "$HS_CONF")

# --- filesystem ----------------------------------------------------------------------------------
install -d -m 0700 -o node -g node /data/headscale /run/headscale
install -d -m 0700 -o root -g root /data/secrets
install -d -m 0755 /run/airbridge
sed "s/__PUBLIC_DOMAIN__/${DOMAIN}/g" /etc/airbridge/headscale.yaml.tmpl > "$HS_CONF"
chmod 0644 "$HS_CONF"

# --- headscale -----------------------------------------------------------------------------------
"${RUN_AS[@]}" "${HS[@]}" configtest >/dev/null 2>&1 || { "${RUN_AS[@]}" "${HS[@]}" configtest || true; die "headscale configtest failed"; }

PIDS=()
cleanup() {
  trap - TERM INT
  for p in "${PIDS[@]}"; do kill -TERM "$p" 2>/dev/null || true; done
  wait || true
}
trap 'cleanup; exit 0' TERM INT

"${RUN_AS[@]}" "${HS[@]}" serve &
PIDS+=($!)

for _ in $(seq 1 60); do
  [ -S /run/headscale/headscale.sock ] && "${RUN_AS[@]}" "${HS[@]}" health >/dev/null 2>&1 && break
  kill -0 "${PIDS[0]}" 2>/dev/null || die "headscale exited during startup"
  sleep 0.5
done
"${RUN_AS[@]}" "${HS[@]}" health >/dev/null 2>&1 || die "headscale did not become healthy"
log info "headscale_ready"

# hs <args>: headscale CLI over the unix socket, JSON output.
hs() { "${RUN_AS[@]}" "${HS[@]}" --force -o json "$@"; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const f=new Function("v","return ("+process.argv[1]+")");const r=f(v);if(r!==undefined&&r!==null)process.stdout.write(String(r));})' "$1"; }

# --- admin API key (created once; rotated after 60 days; 90-day expiry) --------------------------
KEY_FILE=/data/secrets/headscale_api_key
KEY_TS=/data/secrets/headscale_api_key.created
now=$(date +%s)
created=$(cat "$KEY_TS" 2>/dev/null || echo 0)
if [ ! -s "$KEY_FILE" ] || [ $((now - created)) -gt $((60 * 86400)) ]; then
  old_prefix=""
  if [ -s "$KEY_FILE" ]; then
    # hskey-api-<prefix>-<secret>
    old_prefix=$(sed -n 's/^hskey-api-\([A-Za-z0-9]*\)-.*/\1/p' "$KEY_FILE")
  fi
  umask 077
  new_key=$("${RUN_AS[@]}" "${HS[@]}" apikeys create --expiration 90d 2>/dev/null | tr -d '[:space:]')
  [[ "$new_key" =~ ^[A-Za-z0-9._-]{20,512}$ ]] || die "could not create a headscale API key"
  printf '%s' "$new_key" > "$KEY_FILE.tmp" && mv "$KEY_FILE.tmp" "$KEY_FILE"
  printf '%s' "$now" > "$KEY_TS"
  unset new_key
  chmod 0600 "$KEY_FILE" "$KEY_TS"
  if [ -n "$old_prefix" ]; then
    "${RUN_AS[@]}" "${HS[@]}" --force apikeys expire --prefix "$old_prefix" >/dev/null 2>&1 || log warn "old_api_key_expire_failed"
    log info "headscale_api_key_rotated"
  else
    log info "headscale_api_key_created"
  fi
fi

# --- temporary smoke-test hooks ------------------------------------------------------------------
if [ -n "${SMOKE_TEST_USER:-}" ]; then
  [[ "$SMOKE_TEST_USER" =~ ^smoke-[a-z0-9-]{1,30}$ ]] || die "SMOKE_TEST_USER must match smoke-[a-z0-9-]+"
  uid=$(hs users list | json "(v||[]).filter(u=>u.name===\"$SMOKE_TEST_USER\").map(u=>u.id)[0]")
  if [ "${SMOKE_CLEANUP:-}" = "1" ]; then
    if [ -n "$uid" ]; then
      for nid in $(hs nodes list | json "(v||[]).filter(n=>n.user&&String(n.user.id)===\"$uid\").map(n=>n.id).join(\" \")"); do
        hs nodes delete --identifier "$nid" >/dev/null && log info "smoke_node_deleted"
      done
      hs users destroy --identifier "$uid" >/dev/null && log info "smoke_user_deleted"
    else
      log info "smoke_user_absent"
    fi
  else
    if [ -z "$uid" ]; then
      uid=$(hs users create "$SMOKE_TEST_USER" | json "v.id")
    fi
    n="${SMOKE_KEYS:-1}"
    [[ "$n" =~ ^[1-5]$ ]] || die "SMOKE_KEYS must be 1-5"
    for _ in $(seq 1 "$n"); do
      k=$(hs preauthkeys create --user "$uid" --expiration 15m | json "v.key")
      echo "SMOKE_KEY=$k"
    done
    unset k
  fi
fi

# --- license server ------------------------------------------------------------------------------
(
  HEADSCALE_API_KEY="$(cat "$KEY_FILE")"
  export HEADSCALE_API_KEY HEADSCALE_URL=http://127.0.0.1:8081 HEADSCALE_PUBLIC_URL="https://${DOMAIN}"
  export HOST=127.0.0.1 PORT=8787 TRUST_PROXY=1 TRUST_PROXY_HOPS="${TRUST_PROXY_HOPS:-2}"
  export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://${DOMAIN}}"
  unset SMOKE_TEST_USER SMOKE_KEYS SMOKE_CLEANUP
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
