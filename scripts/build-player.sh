#!/usr/bin/env bash
# Bundle the player. No bundler config, no dev server: esbuild only.
set -euo pipefail
cd "$(dirname "$0")/.."

npx --no-install esbuild src/player.js \
  --bundle \
  --format=esm \
  --target=es2022 \
  --minify \
  --sourcemap \
  --outfile=web/player.js \
  --log-level=warning

echo "built web/player.js ($(wc -c < web/player.js) bytes)"
