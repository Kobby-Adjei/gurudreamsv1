#!/bin/sh
# License-server entrypoint (deploy/digitalocean): load secrets from read-only files into the server's own
# environment, so they never appear in compose files, `docker inspect` or logs. Variables: <NAME>_FILE -> <NAME>.
set -eu
for name in HEADSCALE_API_KEY LICENSE_SIGNING_KEY_PEM LICENSE_KEY_ID WAITLIST_ADMIN_TOKEN; do
  eval "file=\${${name}_FILE:-}"
  unset "${name}_FILE"
  [ -n "$file" ] || continue
  if [ ! -r "$file" ]; then
    echo "{\"level\":\"error\",\"msg\":\"secret file missing\",\"var\":\"${name}\"}" >&2
    exit 2
  fi
  value="$(cat "$file")"
  export "$name=$value"
done
exec node /app/dist/server.js
