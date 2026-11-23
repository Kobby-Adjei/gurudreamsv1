#!/usr/bin/env bash
# Build the airbridge-core backend binary for the current OS/arch (macOS/Linux).
#
#   ./airbridge/build_backend.sh            # build + smoke test
#   PYTHON=python3.12 ./airbridge/build_backend.sh
#   AIRBRIDGE_BUILD_VENV=/tmp/abbuild ./airbridge/build_backend.sh
#
# Output: desktop/resources/bin/<os>-<arch>/airbridge-core
# PyInstaller cannot cross-compile: run this on each target OS/arch (CI matrix).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PYTHON="${PYTHON:-python3}"
VENV="${AIRBRIDGE_BUILD_VENV:-$SCRIPT_DIR/.build-venv}"
WORK="${AIRBRIDGE_BUILD_WORK:-$SCRIPT_DIR/build/pyinstaller}"

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) echo "build_backend.sh: unsupported OS $(uname -s); use build_backend.ps1 on Windows" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) echo "build_backend.sh: unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

OUT_DIR="$REPO_ROOT/desktop/resources/bin/$OS-$ARCH"
BIN="$OUT_DIR/airbridge-core"

echo "==> build venv: $VENV"
if [ ! -x "$VENV/bin/python" ]; then
  "$PYTHON" -m venv "$VENV"
fi
"$VENV/bin/python" -m pip install --quiet --upgrade pip
"$VENV/bin/python" -m pip install --quiet -r "$SCRIPT_DIR/requirements.txt" -r "$SCRIPT_DIR/requirements-build.txt"

echo "==> pyinstaller -> $OUT_DIR"
mkdir -p "$OUT_DIR" "$WORK"
(
  cd "$SCRIPT_DIR"
  "$VENV/bin/python" -m PyInstaller --noconfirm --clean \
    --distpath "$OUT_DIR" --workpath "$WORK" \
    "$SCRIPT_DIR/airbridge-core.spec"
)
[ -x "$BIN" ] || { echo "build_backend.sh: binary not produced at $BIN" >&2; exit 1; }

echo "==> smoke test"
SMOKE_TMP="$(mktemp -d)"
trap 'rm -rf "$SMOKE_TMP"' EXIT
export AIRBRIDGE_LOG_FILE="$SMOKE_TMP/airbridge.log"
export AIRBRIDGE_DATA_DIR="$SMOKE_TMP/data"

"$BIN" --help 2>"$SMOKE_TMP/help.err" >"$SMOKE_TMP/help.out"
grep -q -- "--daemon" "$SMOKE_TMP/help.err" || { echo "smoke: --help output missing --daemon" >&2; exit 1; }
[ ! -s "$SMOKE_TMP/help.out" ] || { echo "smoke: --help wrote to stdout" >&2; exit 1; }
echo "    --help ok"

set +e
"$BIN" --check </dev/null >"$SMOKE_TMP/check.out" 2>"$SMOKE_TMP/check.err"
rc=$?
set -e
if [ "$rc" -ne 0 ] && [ "$rc" -ne 2 ]; then
  echo "smoke: --check exited $rc (expected 0, or 2 when Tailscale is absent)" >&2
  cat "$SMOKE_TMP/check.err" >&2
  exit 1
fi
[ ! -s "$SMOKE_TMP/check.out" ] || { echo "smoke: --check wrote to stdout" >&2; exit 1; }
echo "    --check exit $rc ok ($( [ "$rc" -eq 2 ] && echo 'Tailscale not available here' || echo 'Tailscale OK'))"

set +e
env -u AIRBRIDGE_CONTROL_TOKEN "$BIN" --daemon </dev/null >/dev/null 2>"$SMOKE_TMP/daemon.err"
rc=$?
set -e
[ "$rc" -eq 2 ] || { echo "smoke: --daemon without token exited $rc (expected 2)" >&2; exit 1; }
echo "    --daemon without token exit 2 ok"

ls -l "$BIN"
echo "==> done: $BIN"
