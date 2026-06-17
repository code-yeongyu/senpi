#!/usr/bin/env bash
# Universal senpi dev-environment setup (POSIX wrapper).
# Locates Node and delegates to scripts/devenv-setup.mjs (cross-platform logic).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js >= 24 is required. Install it from https://nodejs.org and re-run." >&2
  exit 1
fi
exec node "$DIR/devenv-setup.mjs" "$@"
