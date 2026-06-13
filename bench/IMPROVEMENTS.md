# Task 11 Improvement Ledger

Source: `github-ci-same-run` from `/tmp/task-11-gh-artifact-3/task-11-benchmarks/comparison.json`.

CI same-run evidence compared base `2ae966efb37abaf4b535ffd40545d2580eae10ba` to head `6e771fdbdb7547bb319dafdc030a85fb8960c270` on the same Linux runner with `noiseTolerancePct=5`; `failures=[]`. The downloaded artifact timestamp is `2026-06-13T17:07:00+0900`. A matching GitHub run URL was not discoverable from `gh`; PR #35 on this remote is unrelated.

Note: static Darwin/M4 baseline is diagnostic only on CI/Linux; same-run CI passed. The static-baseline artifact exited `static_status=1` and must not be reported as a pass.

R2 numeric rows are traceable through explicit evidence files: `/tmp/port-gajae-evidence/task-9-compare.json` and `/tmp/port-gajae-evidence/task-9-writecalls.txt`.

| Element | Metric | Baseline (original) | Final | Delta % | Hypothesis met (Y/N/deferred) | Evidence path |
|---|---:|---:|---:|---:|---|---|
| P4 binary size | bytes | 75830114 | 70480226 | 7.06 | Y | `/tmp/port-gajae-evidence/task-5-minify-sizes.txt` |
| R1 jsonl parse | median ms | 13.301500 | 11.195958 | 15.83 | N | `/tmp/port-gajae-evidence/task-11-jsonl-after-inline-cr.json`; `/tmp/port-gajae-evidence/task-8-compare.txt` |
| R1 jsonl parse | p95 ms | 15.038917 | 12.307250 | 18.16 | N | `/tmp/port-gajae-evidence/task-11-jsonl-after-inline-cr.json`; `/tmp/port-gajae-evidence/task-8-compare.txt` |
| R1 original compare JSON | evidence status | missing | missing | n/a | deferred | `/tmp/port-gajae-evidence/task-8-compare.json` |
| R2 rpc event emit | median ms | 22.165084 | 17.141667 | 22.66 | Y | `/tmp/port-gajae-evidence/task-9-compare.json` |
| R2 rpc event emit | writeCalls | 1000 | 1 | 99.90 | Y | `/tmp/port-gajae-evidence/task-9-writecalls.txt` |
| R3 profile | decision | task9 median 16.564042 ms | skipped | n/a | deferred | `/tmp/port-gajae-evidence/task-10-profile.txt` |
| CI same-run ai-event-stream | median/p95 ms | 7.158775 / 13.833058 | 3.667804 / 6.566149 | 48.76 / 52.53 | Y | `/tmp/task-11-gh-artifact-3/task-11-benchmarks/comparison.json` |
| CI same-run ai-model-registry | median/p95 ms | 0.008393 / 0.026869 | 0.008722 / 0.025198 | -3.92 / 6.22 | Y | `/tmp/task-11-gh-artifact-3/task-11-benchmarks/comparison.json` |
| CI same-run tui-editor | median/p95 ms | 33.976652 / 43.042185 | 18.993535 / 25.189029 | 44.10 / 41.48 | Y | `/tmp/task-11-gh-artifact-3/task-11-benchmarks/comparison.json` |
| CI same-run tui-markdown | median/p95 ms | 26.644549 / 26.763114 | 0.194999 / 0.348146 | 99.27 / 98.70 | Y | `/tmp/task-11-gh-artifact-3/task-11-benchmarks/comparison.json` |
| CI same-run coding-agent-render-transcript | median/p95 ms | 29.621960 / 52.961001 | 30.030586 / 48.317684 | -1.38 / 8.77 | Y | `/tmp/task-11-gh-artifact-3/task-11-benchmarks/comparison.json` |
| CI same-run coding-agent-bash-output | median/p95 ms | 52.484795 / 65.471276 | 14.196324 / 20.974882 | 72.95 / 67.96 | Y | `/tmp/task-11-gh-artifact-3/task-11-benchmarks/comparison.json` |
| CI same-run coding-agent-jsonl-parse | suite status | n/a | new-suite | n/a | deferred | `/tmp/task-11-gh-artifact-3/task-11-benchmarks/comparison.json` |
| CI same-run coding-agent-rpc-event-emit | suite status | n/a | new-suite | n/a | deferred | `/tmp/task-11-gh-artifact-3/task-11-benchmarks/comparison.json` |

## Correctness fixes (no perf delta)

- P1: Reassembled split UTF-8 stdin chunks so Korean/CJK/emoji paste no longer mojibakes in the bun-compiled TUI.
- P2: Ignored project `.env` provider credentials in the bun binary path so workspace dotenv cannot override user credentials.
- P3: Omitted forced `tool_choice` for Claude Fable/Mythos while preserving tools, avoiding Anthropic 400s.
- P5: Print mode now emits the last assistant message even when a trailing `toolResult` follows it.
- BONUS: Aborted tool-call replay uses the persisted error label instead of losing the original user-facing failure text.

## Notes

- `/tmp/port-gajae-evidence/task-8-compare.json` is absent. The original Task 8 output in `/tmp/port-gajae-evidence/task-8-compare.txt` missed the 25% median bar, while later JSONL evidence in `/tmp/port-gajae-evidence/task-11-jsonl-after-inline-cr.json` records a smaller measured improvement.
- R3 was skipped from shipping: `/tmp/port-gajae-evidence/task-10-profile.txt` reports closure and backpressure shares of 0.00603717377677301% and 0.0005010854234951096%.
- Local exact static-baseline runs on this host were unreliable under load; user approved using GitHub CI. The ledger source is same-run CI, not `scripts/run-pr530-benchmarks.mjs` static-baseline output.
