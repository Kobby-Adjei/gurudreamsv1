#!/usr/bin/env bash
# provision.sh: create the AirBridge cloud droplet + cloud firewall through the DigitalOcean API (no SSH involved).
#
#   DO_TOKEN=... deploy/digitalocean/provision.sh <40-hex commit> <waitlist-admin-token-file> [smoke-hours]
#
# - <commit>: a commit of the PUBLIC GitHub repo that contains deploy/digitalocean (pushed first). The droplet
#   fetches exactly that commit and refuses to run anything else.
# - <waitlist-admin-token-file>: the existing WAITLIST_ADMIN_TOKEN (kept as the droplet's admin token).
# - [smoke-hours]: >0 enables the TEMPORARY smoke-test endpoints for that many hours (default 0 = off).
# Env: DO_TOKEN (default "proxy-injected": an egress proxy that injects the real token), DO_REGION (nyc3),
#      DO_SIZE (s-1vcpu-1gb-intel: the smallest 1 GiB size offered in nyc3), DO_NAME (airbridge-cloud),
#      AIRBRIDGE_DOMAIN (empty = <ip>.sslip.io), DO_BACKUPS (false).
# Idempotent for the firewall ("airbridge-cloud-fw", applied by tag "airbridge"); refuses if the droplet exists.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMIT="${1:-}"; TOKEN_FILE="${2:-}"; SMOKE_HOURS="${3:-0}"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "usage: $0 <40-hex commit> <token-file> [smoke-hours]" >&2; exit 1; }
[ -r "$TOKEN_FILE" ] || { echo "token file not readable" >&2; exit 1; }
API=https://api.digitalocean.com/v2
AUTH="Authorization: Bearer ${DO_TOKEN:-proxy-injected}"
REGION="${DO_REGION:-nyc3}" SIZE="${DO_SIZE:-s-1vcpu-1gb-intel}" NAME="${DO_NAME:-airbridge-cloud}" TAG=airbridge
do_api() { curl -fsS -H "$AUTH" -H 'Content-Type: application/json' "$@"; }

# The commit must be fetchable anonymously (that is what the droplet does).
curl -fsS -o /dev/null "https://api.github.com/repos/Kobby-Adjei/gurudreamsv1/commits/$COMMIT" \
  || { echo "commit $COMMIT not found on GitHub (push first)" >&2; exit 1; }

if do_api "$API/droplets?tag_name=$TAG" | python3 -c "import json,sys; sys.exit(0 if any(d['name']=='$NAME' for d in json.load(sys.stdin)['droplets']) else 1)"; then
  echo "droplet $NAME already exists; delete it first or use airbridge-update on it" >&2
  exit 1
fi

# --- cloud firewall: 80/tcp, 443/tcp, 3478/udp, ICMP in; port 22 stays CLOSED ---------------------------------
# A firewall can only target an existing tag (creating an existing tag is a no-op).
do_api -o /dev/null -X POST "$API/tags" -d "{\"name\":\"$TAG\"}"
FW_ID="$(do_api "$API/firewalls" | python3 -c "import json,sys; print(next((f['id'] for f in json.load(sys.stdin)['firewalls'] if f['name']=='airbridge-cloud-fw'),''))")"
if [ -z "$FW_ID" ]; then
  FW_ID="$(do_api -X POST "$API/firewalls" -d @- <<JSON | python3 -c "import json,sys; print(json.load(sys.stdin)['firewall']['id'])"
{"name": "airbridge-cloud-fw", "tags": ["$TAG"],
 "inbound_rules": [
  {"protocol": "tcp", "ports": "80",   "sources": {"addresses": ["0.0.0.0/0", "::/0"]}},
  {"protocol": "tcp", "ports": "443",  "sources": {"addresses": ["0.0.0.0/0", "::/0"]}},
  {"protocol": "udp", "ports": "3478", "sources": {"addresses": ["0.0.0.0/0", "::/0"]}},
  {"protocol": "icmp", "sources": {"addresses": ["0.0.0.0/0", "::/0"]}}],
 "outbound_rules": [
  {"protocol": "tcp", "ports": "all", "destinations": {"addresses": ["0.0.0.0/0", "::/0"]}},
  {"protocol": "udp", "ports": "all", "destinations": {"addresses": ["0.0.0.0/0", "::/0"]}},
  {"protocol": "icmp", "destinations": {"addresses": ["0.0.0.0/0", "::/0"]}}]}
JSON
)"
  echo "firewall created: $FW_ID" >&2
else
  echo "firewall exists: $FW_ID" >&2
fi

# --- user_data ------------------------------------------------------------------------------------------------
SMOKE=0; UNTIL=""
if [ "$SMOKE_HOURS" -gt 0 ]; then SMOKE=1; UNTIL=$(( $(date +%s) + SMOKE_HOURS * 3600 )); fi
USER_DATA="$(COMMIT="$COMMIT" DOMAIN="${AIRBRIDGE_DOMAIN:-}" SMOKE="$SMOKE" UNTIL="$UNTIL" TOKEN_FILE="$TOKEN_FILE" \
  python3 - "$HERE/cloud-init.yaml.tmpl" <<'PY'
import os, re, sys
t = open(sys.argv[1]).read()
tok = open(os.environ["TOKEN_FILE"]).read().strip()
assert re.fullmatch(r"[A-Za-z0-9._~+/=-]{32,256}", tok), "bad waitlist token format"
dom = os.environ["DOMAIN"]
assert dom == "" or re.fullmatch(r"[a-z0-9.-]+", dom)
for k, v in {"AIRBRIDGE_COMMIT": os.environ["COMMIT"], "AIRBRIDGE_DOMAIN": dom, "SMOKE_TEST": os.environ["SMOKE"],
             "SMOKE_TEST_UNTIL": os.environ["UNTIL"], "WAITLIST_ADMIN_TOKEN": tok}.items():
    t = t.replace(f"@@{k}@@", v)
assert "@@" not in t
sys.stdout.write(t)
PY
)"
[ "${#USER_DATA}" -lt 64000 ] || { echo "user_data too large" >&2; exit 1; }

# --- droplet --------------------------------------------------------------------------------------------------
BODY="$(USER_DATA="$USER_DATA" python3 -c "
import json, os
print(json.dumps({'name': '$NAME', 'region': '$REGION', 'size': '$SIZE', 'image': 'ubuntu-24-04-x64',
  'ipv6': False, 'monitoring': True, 'backups': '${DO_BACKUPS:-false}' == 'true', 'tags': ['$TAG'],
  'user_data': os.environ['USER_DATA']}))")"
DROPLET_ID="$(printf '%s' "$BODY" | do_api -X POST "$API/droplets" -d @- | python3 -c "import json,sys; print(json.load(sys.stdin)['droplet']['id'])")"
unset BODY USER_DATA
echo "droplet created: $DROPLET_ID (waiting for its public IP)" >&2
for _ in $(seq 1 60); do
  IP="$(do_api "$API/droplets/$DROPLET_ID" | python3 -c "
import json,sys
d=json.load(sys.stdin)['droplet']
print(next((n['ip_address'] for n in d['networks']['v4'] if n['type']=='public'),'') if d['status']=='active' else '')")"
  [ -n "$IP" ] && break
  sleep 5
done
[ -n "$IP" ] || { echo "droplet did not become active" >&2; exit 1; }
HOST="${AIRBRIDGE_DOMAIN:-${IP//./-}.sslip.io}"
echo "droplet_id=$DROPLET_ID ip=$IP host=$HOST firewall=$FW_ID"
echo "first boot takes ~5-8 min; watch: curl -s https://$HOST/healthz   (on failure: http://$IP/airbridge-install.txt)" >&2
