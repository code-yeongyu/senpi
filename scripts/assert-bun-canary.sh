#!/usr/bin/env bash
# Assert the bun toolchain is on the 1.4+ canary channel.
# Canary marker lives in `bun --revision` (e.g. "1.4.0-canary.1+<sha>");
# `bun --version` prints a bare "1.x.y" with no channel marker.
set -euo pipefail

v=$(bun --version)
r=$(bun --revision)

case "$r" in
	*canary*) : ;;
	*)
		echo "::error::expected bun canary channel, got revision $r"
		exit 1
		;;
esac

# Guard the numeric parse so a malformed version fails with a clear message
# instead of aborting under `set -u` with "integer expression expected".
maj=${v%%.*}
rest=${v#*.}
min=${rest%%.*}
case "$maj" in '' | *[!0-9]*) maj=0 ;; esac
case "$min" in '' | *[!0-9]*) min=0 ;; esac

if [ "$maj" -lt 1 ] || { [ "$maj" -eq 1 ] && [ "$min" -lt 4 ]; }; then
	echo "::error::expected bun >= 1.4 (canary), got $v"
	exit 1
fi

echo "bun: $v rev $r" >>"$GITHUB_STEP_SUMMARY"
