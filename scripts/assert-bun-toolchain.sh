#!/usr/bin/env bash
# Assert the bun toolchain is >= 1.4 (stable or canary).
# Bun 1.4.0 is stable as of 2026-08-20; the canary-channel requirement is retired.
set -euo pipefail

v=$(bun --version)
r=$(bun --revision)

# Guard the numeric parse so a malformed version fails with a clear message
# instead of aborting under `set -u` with "integer expression expected".
maj=${v%%.*}
rest=${v#*.}
min=${rest%%.*}
case "$maj" in '' | *[!0-9]*) maj=0 ;; esac
case "$min" in '' | *[!0-9]*) min=0 ;; esac

if [ "$maj" -lt 1 ] || { [ "$maj" -eq 1 ] && [ "$min" -lt 4 ]; }; then
	echo "::error::expected bun >= 1.4, got $v"
	exit 1
fi

echo "bun: $v rev $r" >>"$GITHUB_STEP_SUMMARY"
