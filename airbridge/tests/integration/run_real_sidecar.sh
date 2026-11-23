#!/usr/bin/env bash
# Real private-network integration test (Linux/macOS): Headscale v0.29.7 + three airbridge-net
# sidecars (tsnet v1.104.7) + real AirBridge daemons. Builds what is missing. Opt-in; no system
# Tailscale involved.
#
#   airbridge/tests/integration/run_real_sidecar.sh [extra pytest args]
#
# Env: PYTHON (default python3), AIRBRIDGE_HEADSCALE_BIN (default: build into $CACHE),
# CACHE (default ~/.cache/airbridge-real-sidecar). Needs Go >= 1.24 (GOTOOLCHAIN=auto fetches 1.27.x).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
PY="${PYTHON:-python3}"
CACHE="${CACHE:-$HOME/.cache/airbridge-real-sidecar}"
HS_VERSION="v0.29.7"
export GOTOOLCHAIN=auto CGO_ENABLED=0

host_os() { case "$(uname -s)" in Darwin) echo darwin ;; *) echo linux ;; esac; }
host_arch() { case "$(uname -m)" in x86_64|amd64) echo x64 ;; *) echo arm64 ;; esac; }
NET_BIN="$ROOT/desktop/resources/net/$(host_os)-$(host_arch)/airbridge-net"
[ -x "$NET_BIN" ] || bash "$ROOT/desktop/scripts/build-net.sh"

mkdir -p "$CACHE"
PROBE="$CACHE/meshprobe"
(cd "$ROOT/desktop/sidecar/airbridge-net" && go build -o "$PROBE" ./internal/meshprobe)

if [ -z "${AIRBRIDGE_HEADSCALE_BIN:-}" ]; then
  AIRBRIDGE_HEADSCALE_BIN="$CACHE/headscale-$HS_VERSION"
  if [ ! -x "$AIRBRIDGE_HEADSCALE_BIN" ]; then
    mkdir -p "$CACHE/mod"
    (
      cd "$CACHE/mod"
      [ -f go.mod ] || printf 'module hsbuild\n\ngo 1.24\n' > go.mod
      printf '//go:build tools\n\npackage tools\n\nimport _ "github.com/juanfont/headscale/cmd/headscale"\n' > tools.go
      export GOFLAGS=-mod=mod
      go get "github.com/juanfont/headscale@$HS_VERSION"
      go build -o "$AIRBRIDGE_HEADSCALE_BIN" github.com/juanfont/headscale/cmd/headscale
    )
  fi
fi

export AIRBRIDGE_REAL_SIDECAR=1 AIRBRIDGE_HEADSCALE_BIN AIRBRIDGE_NET_BIN="$NET_BIN" AIRBRIDGE_MESHPROBE_BIN="$PROBE"
cd "$ROOT/airbridge"
exec "$PY" -m pytest -q -p no:cacheprovider tests/integration/test_real_sidecar.py "$@"
