#!/usr/bin/env bash
# Mission init script — idempotent environment bootstrap for the
# todo-continuation-as-todotools-extension mission.
# Runs at the start of each worker session.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '[init] %s\n' "$*"; }

# Ensure node is reachable.
if ! command -v node >/dev/null 2>&1; then
  log "ERROR: node is not on PATH. This mission requires Node >= 20.6.0."
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR}" -lt 20 ]; then
  log "ERROR: node >= 20 required, found $(node --version)."
  exit 1
fi

# Ensure npm dependencies are installed. Only run install when the node_modules
# lock marker is missing, to keep this script fast on re-entry.
if [ ! -d node_modules ] || [ ! -f node_modules/.package-lock.json ]; then
  log "Installing npm workspaces (this may take a minute) ..."
  npm install
else
  log "node_modules already present; skipping npm install."
fi

# Ensure ripgrep is available — used heavily by workers and validators.
if ! command -v rg >/dev/null 2>&1; then
  log "WARN: ripgrep (rg) is not installed. Workers will fall back to slower search."
fi

# Ensure tmux is available for manual-qa features (warn only — not required for non-QA workers).
if ! command -v tmux >/dev/null 2>&1; then
  log "INFO: tmux is not installed. Manual tmux QA features will require it."
fi

# Local-ignore directory for QA evidence (gitignored).
mkdir -p local-ignore

log "Init complete."
