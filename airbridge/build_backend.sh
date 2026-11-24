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
# Wheels only (--only-binary=:all:): never compile a dependency from source on the build
# machine. A source-built cryptography links the runner's Homebrew OpenSSL dynamically and the
# frozen binary then fails on users' Macs; the official wheels link OpenSSL statically.
"$VENV/bin/python" -m pip install --only-binary=:all: \
  -r "$SCRIPT_DIR/requirements.txt" -r "$SCRIPT_DIR/requirements-build.txt"
"$VENV/bin/python" -m pip list --format=freeze | grep -iE '^(cryptography|cffi|pydantic.core|mcp|pyinstaller)==' || true

echo "==> pyinstaller -> $OUT_DIR"
mkdir -p "$OUT_DIR" "$WORK"
(
  cd "$SCRIPT_DIR"
  "$VENV/bin/python" -m PyInstaller --noconfirm --clean \
    --distpath "$OUT_DIR" --workpath "$WORK" \
    "$SCRIPT_DIR/airbridge-core.spec"
)
[ -x "$BIN" ] || { echo "build_backend.sh: binary not produced at $BIN" >&2; exit 1; }

if [ "$OS" = darwin ]; then
  # cryptography's Rust extension must not load OpenSSL dynamically: inside the onefile bundle
  # it would bind to whichever libssl.3.dylib wins (e.g. Python's own older one).
  echo "==> check cryptography links OpenSSL statically"
  RUST_SO="$("$VENV/bin/python" -c 'import cryptography.hazmat.bindings._rust as m; print(m.__file__)')"
  otool -L "$RUST_SO"
  if otool -L "$RUST_SO" | tail -n +2 | grep -qiE 'libssl|libcrypto'; then
    echo "build_backend.sh: $RUST_SO links OpenSSL dynamically (source build?); refusing to ship it" >&2
    exit 1
  fi
  # Same check on the copy inside the onefile binary, plus: no Homebrew dylib in the bundle.
  "$VENV/bin/python" - "$BIN" <<'PY'
import os, subprocess, sys, tempfile
from PyInstaller.archive.readers import CArchiveReader
arc = CArchiveReader(sys.argv[1])
names = sorted(arc.toc)
rust = [n for n in names if n.replace("\\", "/").startswith("cryptography/hazmat/bindings/_rust")]
ssl_libs = [n for n in names if os.path.basename(n).startswith(("libssl", "libcrypto"))]
print("    bundled OpenSSL libraries (Python's _ssl):", ", ".join(ssl_libs) or "none")
if len(rust) != 1:
    sys.exit(f"bundle check: expected one cryptography _rust extension, found {rust}")
with tempfile.TemporaryDirectory() as tmp:
    path = os.path.join(tmp, "_rust.so")
    with open(path, "wb") as fh:
        fh.write(arc.extract(rust[0]))
    out = subprocess.run(["otool", "-L", path], capture_output=True, text=True, check=True).stdout
print(out)
deps = [l.strip() for l in out.splitlines()[1:]]
bad = [d for d in deps if "libssl" in d or "libcrypto" in d or d.startswith(("/usr/local/", "/opt/homebrew/"))]
if bad:
    sys.exit(f"bundle check: bundled {rust[0]} links {bad}; it must link OpenSSL statically")
print("    bundled cryptography _rust links OpenSSL statically: ok")
PY
fi

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

"$BIN" --self-test </dev/null >"$SMOKE_TMP/selftest.out" 2>"$SMOKE_TMP/selftest.err" || {
  cat "$SMOKE_TMP/selftest.err" >&2
  echo "smoke: --self-test failed" >&2
  exit 1
}
[ ! -s "$SMOKE_TMP/selftest.out" ] || { echo "smoke: --self-test wrote to stdout" >&2; exit 1; }
grep -E "cryptography AES-GCM|stdlib ssl|/status ok|PASSED" "$SMOKE_TMP/selftest.err"
echo "    --self-test ok"

ls -l "$BIN"
echo "==> done: $BIN"
