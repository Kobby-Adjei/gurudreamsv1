# Shared helpers for the airbridge-* host scripts (deploy/digitalocean). Installed to /usr/local/lib/airbridge/.
# Never print secrets: no `set -x`, secret values are only ever written to 0400/0600 files.
# shellcheck shell=bash

AIRBRIDGE_ETC="${AIRBRIDGE_ETC:-/etc/airbridge}"
AIRBRIDGE_SRC="${AIRBRIDGE_SRC:-/opt/airbridge/src}"
AIRBRIDGE_STATE="${AIRBRIDGE_STATE:-/var/lib/airbridge}"
AIRBRIDGE_SECRETS="$AIRBRIDGE_STATE/secrets"
AIRBRIDGE_COMPOSE_FILE="$AIRBRIDGE_SRC/deploy/digitalocean/docker-compose.yml"
# Container users: node (license server) and Headscale's nonroot user.
NODE_UID=1000
HEADSCALE_UID=65532

log() { printf '%s airbridge: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root"

load_env() {
  [ -r "$AIRBRIDGE_ETC/airbridge.env" ] || die "$AIRBRIDGE_ETC/airbridge.env missing"
  set -a
  # shellcheck disable=SC1091
  . "$AIRBRIDGE_ETC/airbridge.env"
  set +a
}

compose() {
  docker compose -p airbridge -f "$AIRBRIDGE_COMPOSE_FILE" --env-file "$AIRBRIDGE_ETC/runtime.env" "$@"
}

# Set KEY=VALUE in airbridge.env (adds the line if missing).
set_env_var() {
  local key="$1" value="$2" f="$AIRBRIDGE_ETC/airbridge.env"
  if grep -q "^${key}=" "$f"; then
    sed -i -E "s|^${key}=.*|${key}=${value}|" "$f"
  else
    printf '%s=%s\n' "$key" "$value" >>"$f"
  fi
}

# GET /healthz inside the license-server container -> prints the policy field.
policy_status() {
  compose exec -T license-server node -e \
    "fetch('http://127.0.0.1:8787/healthz').then(r=>r.json()).then(j=>console.log(j.policy),()=>console.log('down'))" 2>/dev/null || echo down
}

wait_policy_verified() {
  local i s
  for i in $(seq 1 30); do
    s="$(policy_status)"
    [ "$s" = verified ] && return 0
    sleep 2
  done
  log "license server policy status: ${s:-unknown}"
  return 1
}
