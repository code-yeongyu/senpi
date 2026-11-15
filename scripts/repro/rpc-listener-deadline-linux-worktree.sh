#!/bin/bash
# #6714 reproduction: RPC suites that go red on a worktree whose workspace packages are NOT built.
# Run from a senpi checkout root.
#
#   bash scripts/repro/rpc-listener-deadline-linux-worktree.sh
#
# The spawned host is `node dist/cli.js`; without a build it dies with
#   ERR_MODULE_NOT_FOUND .../packages/coding-agent/dist/valid-cwd.js imported from dist/cli.js
# and the suite surfaces it in one of two shapes:
#   - "Listener deadline: <stderr>"            (rpc-worker-permission-preset)
#   - "RPC stream closed before expected record" (rpc-worker-isolation, 3864-lifecycle-freshness)
#
# test/suite/rpc-delegated-connection.test.ts is NOT listed: its host is built in-process
# (test/suite/rpc-delegated-host-support.ts) and it passes on an unbuilt tree, so a red there has
# its own cause.
set -uo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT/packages/coding-agent" || { echo "no packages/coding-agent under $ROOT" >&2; exit 2; }
FILES=(
  test/suite/rpc-worker-permission-preset.test.ts
  test/suite/rpc-worker-isolation.test.ts
  test/suite/regressions/3864-lifecycle-freshness.test.ts
)
rc=0
for f in "${FILES[@]}"; do
  echo "===== $f"
  out=$(CI=1 node ../../scripts/run-tests.mjs vitest --run "$f" 2>&1)
  echo "$out" | grep -aE 'Test Files|Tests  |Listener deadline|RPC stream closed|ERR_MODULE_NOT_FOUND|dist/valid-cwd' | head -8
  echo "$out" | grep -aqE 'Listener deadline|RPC stream closed' && rc=1
done
echo "REPRO_RC=$rc (1 = an unbuilt-workspace failure reproduced)"
exit $rc
