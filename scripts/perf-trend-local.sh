#!/usr/bin/env bash

set -uo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
output_path="${PERF_TREND_OUTPUT:-"$repo_root/perf-trend.json"}"
frame_small_n="${PERF_TREND_FRAME_SMALL_N:-1000}"
frame_large_n="${PERF_TREND_FRAME_LARGE_N:-10000}"
injected_failure_used=0

: > "$output_path"

append_normalized_entry() {
	local label="$1"
	local kind="$2"
	local source_path="$3"

	python3 -c '
import json
import sys

label = sys.argv[1]
kind = sys.argv[2]
raw = json.load(sys.stdin)

if kind == "frame-cost":
    entry = {
        "suite": "frame-cost",
        "label": label,
        "n": raw["n"],
        "p50Ms": raw["p50Ms"],
        "p95Ms": raw["p95Ms"],
        "bytesPerFrameP50": raw["bytesPerFrameP50"],
        "raw": raw,
    }
else:
    entry = {
        "suite": raw["suite"],
        "label": label,
        "n": raw["iterations"],
        "p50Ms": raw["medianMs"],
        "p95Ms": raw["p95Ms"],
        "bytesPerFrameP50": None,
        "raw": raw,
    }

print(json.dumps(entry, separators=(",", ":")))
' "$label" "$kind" < "$source_path" >> "$output_path"
}

run_bench() {
	local label="$1"
	local kind="$2"
	shift 2

	if [[ "${PERF_TREND_INJECT_FAIL:-}" == "1" && "$injected_failure_used" == "0" && "$label" == "frame-cost-n${frame_large_n}" ]]; then
		injected_failure_used=1
		echo "bench failed (advisory)"
		return 0
	fi

	local bench_output
	bench_output="$(mktemp)"
	if (cd "$repo_root/packages/tui" && "$@") > "$bench_output"; then
		if ! append_normalized_entry "$label" "$kind" "$bench_output"; then
			echo "bench failed (advisory)"
		fi
	else
		echo "bench failed (advisory)"
	fi
	rm -f "$bench_output"
}

run_bench "frame-cost-n${frame_small_n}" frame-cost npx tsx bench/frame-cost.ts --n "$frame_small_n"
run_bench "frame-cost-n${frame_large_n}" frame-cost npx tsx bench/frame-cost.ts --n "$frame_large_n"
run_bench "frame-cost-n${frame_large_n}-viewport" frame-cost env PI_TUI_VIEWPORT_RENDER=1 npx tsx bench/frame-cost.ts --n "$frame_large_n"
if [[ -n "${PERF_TREND_ITERATIONS:-}" ]]; then
	run_bench "editor-layout" suite npx tsx bench/editor-layout.ts --iterations "$PERF_TREND_ITERATIONS"
	run_bench "markdown-render" suite npx tsx bench/markdown-render.ts --iterations "$PERF_TREND_ITERATIONS"
else
	run_bench "editor-layout" suite npx tsx bench/editor-layout.ts
	run_bench "markdown-render" suite npx tsx bench/markdown-render.ts
fi
