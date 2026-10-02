#!/bin/sh
set -e

# /app/node_modules is a named volume rather than part of the bind mount: the
# host's install holds macOS binaries, which will not run here. It starts empty,
# so the first boot of a fresh volume populates it.
if [ -z "$(ls -A /app/node_modules 2>/dev/null)" ]; then
  echo 'bunbraco: installing dependencies into the container volume...'
  (cd /app && bun install --frozen-lockfile)
fi

exec "$@"
