#!/usr/bin/env bash
# Dev runner for the neo Go TUI.
#
# Builds and runs the Go TUI from source (`go run ./cmd/senpi-neo`) with
# SENPI_NEO_CLI_PATH pointed at the repo's TypeScript CLI entry, so the bridge
# can spawn `node <cli> --mode rpc` against the live working tree (the same
# entry pi-test.sh and senpi-qa run via tsx: packages/coding-agent/src/cli.ts).
#
# Works whether invoked from the repo root or from packages/neo itself.
#
# Usage:
#   ./packages/neo/neo-test.sh --version
#   ./packages/neo/neo-test.sh [tui args...]
set -euo pipefail

# Directory of this script == packages/neo.
NEO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Repo root is two levels up (packages/neo -> packages -> root).
REPO_ROOT="$(cd "$NEO_DIR/../.." && pwd)"

# The TypeScript CLI entry the future bridge spawns as `node <cli> --mode rpc`.
# Allow an existing override to win so callers can point at a built dist entry.
CLI_ENTRY="${SENPI_NEO_CLI_PATH:-$REPO_ROOT/packages/coding-agent/src/cli.ts}"
export SENPI_NEO_CLI_PATH="$CLI_ENTRY"

if [[ ! -e "$SENPI_NEO_CLI_PATH" ]]; then
  echo "neo-test.sh: warning: CLI entry not found at $SENPI_NEO_CLI_PATH" >&2
fi

if ! command -v go >/dev/null 2>&1; then
  echo "neo-test.sh: error: Go toolchain not found on PATH" >&2
  exit 127
fi

cd "$NEO_DIR"
exec go run ./cmd/senpi-neo "$@"
