#!/usr/bin/env bash
# Real tailnet integration test (Linux/macOS): Headscale v0.29.7 + 3 userspace
# tailscaled v1.104.7 + the real AirBridge daemon/outbox. Builds what is missing.
#
#   airbridge/tests/integration/run_real_tailnet.sh [extra pytest args]
#
# Env: PYTHON (default: python3), AIRBRIDGE_HEADSCALE_BIN (default: build into
# $CACHE), CACHE (default: ~/.cache/airbridge-real-tailnet). Needs Go >= 1.24
# (GOTOOLCHAIN=auto downloads Go 1.27.x) and free ports 8989, 28281, 29291,
# 50643, 23579/udp, 21181-21183 on 127.0.0.1.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
PY="${PYTHON:-python3}"
CACHE="${CACHE:-$HOME/.cache/airbridge-real-tailnet}"
HS_VERSION="v0.29.7"

host_os() { case "$(uname -s)" in Darwin) echo darwin ;; *) echo linux ;; esac; }
host_arch() { case "$(uname -m)" in x86_64|amd64) echo x64 ;; *) echo arm64 ;; esac; }
TS_DIR="$ROOT/desktop/resources/tailscale/$(host_os)-$(host_arch)"
if [ ! -x "$TS_DIR/tailscaled" ]; then
  bash "$ROOT/desktop/scripts/build-tailscale.sh"
fi

if [ -z "${AIRBRIDGE_HEADSCALE_BIN:-}" ]; then
  AIRBRIDGE_HEADSCALE_BIN="$CACHE/headscale-$HS_VERSION"
  if [ ! -x "$AIRBRIDGE_HEADSCALE_BIN" ]; then
    mkdir -p "$CACHE/mod"
    (
      cd "$CACHE/mod"
      [ -f go.mod ] || printf 'module hsbuild\n\ngo 1.24\n' > go.mod
      printf '//go:build tools\n\npackage tools\n\nimport _ "github.com/juanfont/headscale/cmd/headscale"\n' > tools.go
      export GOTOOLCHAIN=auto GOFLAGS=-mod=mod CGO_ENABLED=0
      go get "github.com/juanfont/headscale@$HS_VERSION"
      go build -o "$AIRBRIDGE_HEADSCALE_BIN" github.com/juanfont/headscale/cmd/headscale
    )
  fi
fi

export AIRBRIDGE_REAL_TAILNET=1 AIRBRIDGE_HEADSCALE_BIN AIRBRIDGE_TAILSCALE_DIR="$TS_DIR"
cd "$ROOT/airbridge"
exec "$PY" -m pytest -q -p no:cacheprovider tests/integration/test_real_tailnet.py "$@"
