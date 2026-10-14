#!/bin/sh
set -e

# /app/node_modules is a named volume rather than part of the bind mount: the
# host's install holds macOS binaries, which will not run here. It is installed
# again whenever bun.lock differs from the one it was last installed from, not
# only when it is empty. A volume left behind the lockfile still boots, but the
# workspace links that come through the bind mount (packages/*/node_modules)
# point at packages it never installed, and fail only when something imports one.
STAMP=/app/node_modules/.bun-lock.sha256
LOCK=$(sha256sum /app/bun.lock | cut -d ' ' -f 1)
if [ "$(cat "$STAMP" 2>/dev/null)" != "$LOCK" ]; then
  echo 'crombolo: bun.lock has changed, installing dependencies into the container volume...'
  (cd /app && bun install --frozen-lockfile)
  echo "$LOCK" > "$STAMP"
fi

exec "$@"
