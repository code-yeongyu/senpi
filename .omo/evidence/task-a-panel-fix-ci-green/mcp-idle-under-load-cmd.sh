#!/bin/bash
cd /tmp/fix-142-codemode/packages/coding-agent
pids=""
for i in $(seq 20); do yes > /dev/null & pids="$pids $!"; done
for run in 1 2 3; do
  printf "recovery run %s under load: " "$run"
  npx vitest run test/mcp/idle.test.ts -t "keep-alive pings every 30 seconds" 2>&1 | grep -E 'Tests .*(passed|failed)|condition timed out' | tr '\n' ' '
  echo ""
done
kill $pids 2>/dev/null || true
echo "load killed"
