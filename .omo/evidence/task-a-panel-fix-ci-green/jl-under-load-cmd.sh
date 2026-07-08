#!/bin/bash
set -e
cd /tmp/fix-142-codemode/packages/senpi-codemode
export PATH="$HOME/.juliaup/bin:$PATH"
export JULIA_DEPOT_PATH=$(mktemp -d)
pids=""
for i in $(seq 20); do yes > /dev/null & pids="$pids $!"; done
sleep 1
echo "load: $(echo $pids | wc -w) burners on $(sysctl -n hw.ncpu) cores"
START=$(date +%s)
npx tsx ../../node_modules/vitest/dist/cli.js --run test/jl-kernel.test.ts 2>&1 | grep -E 'Tests .*(passed|failed)|Precompil'
echo "wall: $(( $(date +%s) - START ))s"
kill $pids 2>/dev/null || true
echo "load killed"
