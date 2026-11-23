#!/usr/bin/env bash
# Build the airbridge-net private-network sidecar (desktop/sidecar/airbridge-net, tsnet v1.104.7).
#
#   desktop/scripts/build-net.sh                         # host platform
#   desktop/scripts/build-net.sh darwin/arm64 darwin/amd64 windows/amd64 linux/amd64
#   desktop/scripts/build-net.sh all                     # the four above
#
# Output: desktop/resources/net/<platform>-<arch>/airbridge-net[.exe] + manifest.json (sha256),
# where <platform>-<arch> uses Node/electron-builder names (darwin-arm64, darwin-x64, win32-x64,
# linux-x64). Also copies Tailscale's BSD-3-Clause LICENSE to desktop/resources/licenses/.
# Pure Go (CGO_ENABLED=0), so every target cross-compiles from any host. Needs Go >= 1.24 with
# GOTOOLCHAIN=auto (go.mod pins Go 1.27.4; the toolchain is downloaded once).
#
# S-1 (PHASE3_SECURITY.md): tailscale.com is vendored (`go mod vendor`, vendor/ is gitignored) and
# net/dnsfallback/dns-fallback-servers.json is replaced with {"Regions":{}}, so tsnet's bootstrap-DNS
# fallback can never contact Tailscale's derpN.tailscale.com; the only DERP servers come from our
# Headscale netmap. Builds use -mod=vendor, the guard test runs against the vendored tree, and every
# binary is scanned for derpN.tailscale.com (the build fails if one is found).
#   BUILD_NET_SKIP_TEST=1   skip `go test` (default: run it once before building)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP="$(cd "$HERE/.." && pwd)"
SRC="$DESKTOP/sidecar/airbridge-net"
OUT_BASE="$DESKTOP/resources/net"
LICENSES="$DESKTOP/resources/licenses"
TS_VERSION="v1.104.7"

export GOTOOLCHAIN="${GOTOOLCHAIN:-auto}" CGO_ENABLED=0
unset GOFLAGS

host_target() {
  local os arch
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; MINGW*|MSYS*|CYGWIN*) os=windows ;;
    *) echo "build-net.sh: unsupported OS $(uname -s)" >&2; exit 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;;
    *) echo "build-net.sh: unsupported arch $(uname -m)" >&2; exit 1 ;; esac
  echo "$os/$arch"
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

TARGETS=("$@")
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=("$(host_target)")
[ "${TARGETS[0]}" = "all" ] && TARGETS=(darwin/arm64 darwin/amd64 windows/amd64 linux/amd64)

cd "$SRC"
GO_VERSION="$(go env GOVERSION)"

echo "==> vendoring tailscale.com $TS_VERSION and removing the Tailscale DNS-fallback servers (S-1)"
go mod verify >/dev/null
go mod vendor
FALLBACK="vendor/tailscale.com/net/dnsfallback/dns-fallback-servers.json"
[ -f "$FALLBACK" ] || { echo "build-net.sh: $FALLBACK not found (tailscale.com layout changed?)" >&2; exit 1; }
printf '{"Regions":{}}\n' >"$FALLBACK"
if [ "${BUILD_NET_SKIP_TEST:-0}" != 1 ]; then
  echo "==> go test -mod=vendor ./..."
  go test -mod=vendor -count=1 ./...
fi
for t in "${TARGETS[@]}"; do
  goos="${t%/*}"; goarch="${t#*/}"
  case "$goos/$goarch" in
    darwin/arm64|darwin/amd64|windows/amd64|linux/amd64|linux/arm64) ;;
    *) echo "build-net.sh: unsupported target $t" >&2; exit 1 ;;
  esac
  plat="$goos"; [ "$goos" = windows ] && plat=win32
  arch="$goarch"; [ "$goarch" = amd64 ] && arch=x64
  exe="airbridge-net"; [ "$goos" = windows ] && exe="airbridge-net.exe"
  out="$OUT_BASE/$plat-$arch"
  mkdir -p "$out"
  echo "==> airbridge-net $goos/$goarch -> $out/$exe"
  GOOS="$goos" GOARCH="$goarch" go build -mod=vendor -trimpath -ldflags "-s -w" -o "$out/$exe" .
  if LC_ALL=C grep -a -q -E 'derp[0-9]+[a-z]?\.tailscale\.com' "$out/$exe"; then
    rm -f "$out/$exe"
    echo "build-net.sh: $exe still embeds Tailscale DERP hostnames (DNS fallback not removed); refusing" >&2
    exit 1
  fi
  sum="$(sha256 "$out/$exe")"
  size="$(wc -c <"$out/$exe" | tr -d ' ')"
  cat >"$out/manifest.json" <<JSON
{
  "name": "airbridge-net",
  "tailscale_version": "$TS_VERSION",
  "go_version": "$GO_VERSION",
  "goos": "$goos",
  "goarch": "$goarch",
  "files": {
    "$exe": { "sha256": "$sum", "size": $size }
  }
}
JSON
  echo "    sha256 $sum ($size bytes)"
done

# License notice for the embedded Tailscale code (BSD-3-Clause).
MODDIR="$(go list -mod=mod -m -f '{{.Dir}}' tailscale.com)"
mkdir -p "$LICENSES"
cp "$MODDIR/LICENSE" "$LICENSES/tailscale-LICENSE"
chmod 0644 "$LICENSES/tailscale-LICENSE"
echo "==> done"
