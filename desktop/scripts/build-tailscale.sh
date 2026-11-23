#!/usr/bin/env bash
# Build the bundled Tailscale client (tailscaled + tailscale CLI) from source.
#
#   desktop/scripts/build-tailscale.sh                 # host platform
#   desktop/scripts/build-tailscale.sh darwin arm64    # cross-compile (CGO off)
#   desktop/scripts/build-tailscale.sh win32 x64
#
# Platform/arch use Node/Electron names (darwin|linux|win32, x64|arm64) so the
# output dir matches electron-builder's ${platform}-${arch}; Go names
# (windows, amd64) are accepted too.
#
# Output: desktop/resources/tailscale/<platform>-<arch>/{tailscaled,tailscale}[.exe]
#         + manifest.json (version, go version, sha256 per file)
#         desktop/resources/licenses/tailscale-LICENSE (BSD-3-Clause)
#
# Versions are pinned by scripts/tailscale-mod/go.mod + go.sum (checksummed).
# Needs Go >= 1.24 on PATH; GOTOOLCHAIN=auto downloads the toolchain go.mod asks for.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP="$(cd "$HERE/.." && pwd)"
MOD="$HERE/tailscale-mod"
TS_VERSION="v1.104.7"

host_os() { case "$(uname -s)" in Darwin) echo darwin ;; Linux) echo linux ;; MINGW*|MSYS*|CYGWIN*) echo win32 ;; *) echo unknown ;; esac; }
host_arch() { case "$(uname -m)" in x86_64|amd64) echo x64 ;; arm64|aarch64) echo arm64 ;; *) echo unknown ;; esac; }

PLATFORM="${1:-$(host_os)}"
ARCH="${2:-$(host_arch)}"

case "$PLATFORM" in
  darwin|macos|mac) PLATFORM=darwin; GOOS_=darwin ;;
  linux) GOOS_=linux ;;
  win32|windows|win) PLATFORM=win32; GOOS_=windows ;;
  *) echo "unsupported platform: $PLATFORM" >&2; exit 2 ;;
esac
case "$ARCH" in
  x64|amd64) ARCH=x64; GOARCH_=amd64 ;;
  arm64|aarch64) ARCH=arm64; GOARCH_=arm64 ;;
  *) echo "unsupported arch: $ARCH" >&2; exit 2 ;;
esac
EXE=""; [ "$GOOS_" = windows ] && EXE=".exe"

OUT="$DESKTOP/resources/tailscale/$PLATFORM-$ARCH"
LIC_DIR="$DESKTOP/resources/licenses"
mkdir -p "$OUT" "$LIC_DIR"

command -v go >/dev/null 2>&1 || { echo "go not found on PATH (need Go >= 1.24; GOTOOLCHAIN=auto fetches the rest)" >&2; exit 1; }

echo "building tailscale $TS_VERSION for $GOOS_/$GOARCH_ -> $OUT" >&2
(
  cd "$MOD"
  export GOTOOLCHAIN=auto CGO_ENABLED=0 GOOS="$GOOS_" GOARCH="$GOARCH_" GOFLAGS=-mod=readonly
  # -o <dir>/ with several packages writes one binary per package into the dir.
  V="${TS_VERSION#v}"
  # Same version stamps as upstream build_dist.sh (else "<ver>-ERR-BuildInfo").
  go build -trimpath \
    -ldflags "-s -w -X tailscale.com/version.longStamp=$V-airbridge -X tailscale.com/version.shortStamp=$V" \
    -o "$OUT/" tailscale.com/cmd/tailscaled tailscale.com/cmd/tailscale
)

GOVER="$(cd "$MOD" && GOTOOLCHAIN=auto go env GOVERSION)"
LICENSE_SRC="$(cd "$MOD" && GOTOOLCHAIN=auto GOFLAGS=-mod=readonly go list -m -f '{{.Dir}}' tailscale.com)/LICENSE"
cp "$LICENSE_SRC" "$LIC_DIR/tailscale-LICENSE"
chmod 0644 "$LIC_DIR/tailscale-LICENSE"

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
TSD="tailscaled$EXE"; TSC="tailscale$EXE"
chmod 0755 "$OUT/$TSD" "$OUT/$TSC" 2>/dev/null || true
cat > "$OUT/manifest.json" <<JSON
{
  "name": "tailscale",
  "version": "$TS_VERSION",
  "go": "$GOVER",
  "goos": "$GOOS_",
  "goarch": "$GOARCH_",
  "license": "BSD-3-Clause (see licenses/tailscale-LICENSE)",
  "files": {
    "$TSD": "$(sha "$OUT/$TSD")",
    "$TSC": "$(sha "$OUT/$TSC")"
  }
}
JSON
echo "ok: $(ls -1 "$OUT" | tr '\n' ' ')" >&2
