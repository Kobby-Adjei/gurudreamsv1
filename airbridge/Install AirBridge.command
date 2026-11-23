#!/bin/bash
# Double-click this file in Finder to set up AirBridge on your Mac.

cd "$(dirname "$0")" || exit 1
clear 2>/dev/null

finish() {
  echo
  read -r -p "  Press Enter to close this window. " _
  exit "${1:-0}"
}

# Find a Python that is 3.11 or newer. Apple's built-in python3 is usually
# too old, so it is tried last.
PYTHON=""
for candidate in \
  python3.13 python3.12 python3.11 \
  /Library/Frameworks/Python.framework/Versions/Current/bin/python3 \
  /opt/homebrew/bin/python3 /usr/local/bin/python3 \
  python3 /usr/bin/python3; do
  if command -v "$candidate" >/dev/null 2>&1 &&
     "$candidate" -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 11) else 1)' >/dev/null 2>&1; then
    PYTHON="$candidate"
    break
  fi
done

if [ -z "$PYTHON" ]; then
  echo
  echo "  AirBridge needs Python 3.11 or newer, and this Mac doesn't have it yet."
  echo
  echo "  1. Download Python from https://www.python.org/downloads/"
  echo "  2. Open the downloaded file and follow the steps."
  echo "  3. Double-click Install AirBridge again."
  echo
  read -r -p "  Press Enter to open the download page (or close this window). " _
  open "https://www.python.org/downloads/" 2>/dev/null
  exit 1
fi

"$PYTHON" install.py "$@"
finish $?
