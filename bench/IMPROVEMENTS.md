# Task 11 Improvement Ledger

Source: `github-ci-same-run` from `/tmp/task-11-gh-artifact-3/task-11-benchmarks/comparison.json`.

CI same-run evidence compared base `2ae966efb37abaf4b535ffd40545d2580eae10ba` to head `6e771fdbdb7547bb319dafdc030a85fb8960c270` on the same Linux runner with `noiseTolerancePct=5`; `failures=[]`. The downloaded artifact timestamp is `2026-06-13T17:07:00+0900`. A matching GitHub run URL was not discoverable from `gh`; PR #35 on this remote is unrelated.

Note: static Darwin/M4 baseline is diagnostic only on CI/Linux; same-run CI passed. The static-baseline artifact exited `static_status=1` and must not be reported as a pass.

R2 numeric rows are traceable through explicit evidence files: `/tmp/port-gajae-evidence/task-9-compare.json` and `/tmp/port-gajae-evidence/task-9-writecalls.txt`.

## Remaining gajae 3-day optimizations (2026-06-15)

| Item | Suite/status | Baseline median | Final median | Median delta % | Baseline p95 | Final p95 | P95 delta % | PR | Evidence |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| WI-5 word-diff | word-diff / 5-single-line-diff-cases | 22.34375 ms | 8.1148340000002 ms | 63.68186181818092 | 26.71362499999998 ms | 22.63858300000004 ms | 15.254545199312869 | [#41](https://github.com/code-yeongyu/senpi/pull/41), merge `1da1ab5e4ba1bc65c340820ccc4e110bade9b7f3`, merged `2026-06-15T15:10:23Z` | `/tmp/wi5-word-diff-base.json`; `/tmp/wi5-word-diff-final-head.json`; `.omo/start-work/evidence/wi5-bench-summary.txt`; comparisonFailures `[]`; hypothesis met Y |
| WI-3 compaction-trim | compaction-trim / 500-1000-2000-message-emergency-prune | 29.648124999999936 ms | 12.111666000000014 ms | 59.14862744271336 | 44.001916999999935 ms | 24.484874999999988 ms | 44.354981170479405 | [#42](https://github.com/code-yeongyu/senpi/pull/42), merge `a3a31da9be6549df1386b3ed301438f38b024a91`, merged `2026-06-15T16:40:01Z` | `/tmp/wi3-compaction-trim-base.json`; `/tmp/wi3-compaction-trim-final-head.json`; `.omo/start-work/evidence/wi3-bench-summary.txt`; comparisonFailures `[]`; hypothesis met Y |
| WI-4 emit-context-clone | emit-context-clone / 10-100-1000-json-context-messages | 2.2787920000000668 ms | 1.6458749999999327 ms | 27.77423301469004 | 2.606625000000008 ms | 1.8852500000000418 ms | 27.674675106697897 | [#43](https://github.com/code-yeongyu/senpi/pull/43), merge `2fc7a02bcc44e868d0cc7b7cf1108451ce410e84`, merged `2026-06-15T17:39:51Z` | `/tmp/wi4-emit-context-clone-base.json`; `/tmp/wi4-emit-context-clone-head.json`; `.omo/start-work/evidence/wi4-bench-summary.txt`; comparisonFailures `[]`; hypothesis met Y |
| WI-2 mutation safety | deferred / no code shipped | n/a | n/a | n/a | n/a | n/a | n/a | n/a | `.omo/start-work/evidence/wi2-mutation-safety-deferred.txt` |

WI-2 is deferred and no code shipped. Explorer the 4th found in-place mutation of existing `AgentMessage` objects in `packages/agent/src/proxy.ts:217-218`, `packages/agent/src/proxy.ts:247-325`, `packages/agent/src/proxy.ts:351-358`, `packages/coding-agent/src/core/agent-session.ts:786-845`, and `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3185-3191`. `buildSessionContext().messages` is assigned into mutable state at `packages/coding-agent/src/core/agent-session-runtime.ts:253`, `packages/coding-agent/src/core/agent-session.ts:2126`, `packages/coding-agent/src/core/agent-session.ts:3436`, and `packages/coding-agent/src/core/sdk.ts:379`. Decision: deferred / needs deeper proof; shared-object cache not shipped.

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
