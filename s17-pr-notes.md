# S17 local delivery (part of #4272)

## Scope and binding decisions

RULING-98 digest correction: b3bf76cea0bb0afc5adde3e968117ae45496ed7d. Separate index-description fold: aa30b6902fe74751e4b2ea62ef6b4dc052eaccdb. Base merged from origin/feat/4272-s16-consumer at 629c344bb2b82fe53299ef265e365b140ca4bb1f (merge a8e0aaf516362f2c51923b22b21072e920568ec6). Desktop agreement is a merge prerequisite owned separately, not a local execution wait. Nothing pushed.

## Contract evidence

| Contract | RED | GREEN evidence |
| --- | --- | --- |
| RULING-98 / R4.B3 / T1 | Raw SHA-256 goldens disagreed with all 21 producer fragments; production-codec verifier failed 12 tests. | Fragment fixture verifier 18/18; production producePage compared exact offsets, lengths, next/complete, pinned data and codec digests in all 8 valid cases. The independent receiver verifier also covers digest-mismatch, stale-ref and out-of-order-offset (all 11 shared cases). |
| T7 / RULING-66 / RULING-73 | Actual socket lacked advertisement and ACK pair, accepted pre-selection admission and downgrade. | Actual TCP declarations and admissions, plus ten exact compact-acks goldens, verify OFF/no-data ACK, ON paired selection, repeated and omitted declarations, session ownership, independent flags, rejected downgrade/incomplete pair, no-ID heartbeat and reconnect. |
| T2 / X06 | Compact attach was rejected by the old unknown-admission guard. Worker session ACK was received privately but discarded because request ALS did not cross the isolate. | Attach/reset/required mirror test passes through S15 admission, and worker ACK reaches its actual socket after bounded identity scope crosses private frames. No retained request lookup index. |
| OFF / old RpcClient | Discovery-only capability delta made the old ON-versus-OFF equality stale. | Exact OFF h-legacy golden remains unchanged; the existing real RpcClient test separately asserts the ON discovery pair and then compares every other request/frame byte. Internal capture and worker transport are unconditional. |

The production fixture normalization check removed digest-named keys and found an empty normalized JSON diff across 12 files; later digestRule prose was changed only under the owner's separate D17 fold. The d-before-answer admission golden was regenerated for the new explicit selection prelude; a/b/c/e/g and h-legacy remain unchanged.

## Implementation

The socket registration owns one CompactSelection. Validation precedes roles, pending capabilities and writer mutation. Legacy format freezes only on content-producing admission; status-only observation does not freeze it. A rejected first compact selection cannot fall through to an open. Complete factory support is explicit; unknown/external factories default unsupported and mixed factories can reject a profile before any physical hold. Classic discovery filters inherited compact tokens and refuses direct compact selection. New peers get new registration state.

Host and session declarations use the same preflight. Worker capability callbacks may acknowledge only host-accepted capability state. Private worker frames carry only reply identity, not a duplicate command body; the original request scope is restored during publication, so stale ownership remains subject to the existing admission check. Selected control ACKs stay correlated controls at final encoding. Required mirrors fail closed on a future lane-less match.

The OFF private-capture test also went RED because AgentSession still gated its private recovery identity on the public rollout flag. Making the upstream identity unconditional restored canonical carrier ownership; the actual private worker observer now proves capture and transport under both flag states without asking a raw socket to retain unconsumed compact leases.

## Validation commands

All commands use Node 24, CI=1, nice -n 10, task TMPDIR and the five brief-listed session variables removed. Tests run one file per invocation with --no-file-parallelism; no wide suite. Root build/check, changes-md --staged and changelog gate are required final checks. See final report for exact outputs and per-file LOC. The numeric fragment changes/unreleased/4272.md is used because the gate rejects the requested nonnumeric s17.md name.

## Test files

- packages/coding-agent/test/suite/fragment-record-fixtures.test.ts
- packages/coding-agent/test/suite/regressions/4272-admission-legacy-golden.test.ts
- packages/coding-agent/test/suite/rpc-session-status-support.ts
- packages/coding-agent/test/suite/regressions/4272-compact-ack-goldens.test.ts
- packages/coding-agent/test/suite/regressions/4272-compact-negotiation-admission.test.ts
- packages/coding-agent/test/suite/regressions/4272-compact-negotiation-socket.test.ts
- packages/coding-agent/test/suite/regressions/4272-negotiated-fragments.test.ts
- packages/coding-agent/test/suite/regressions/4272-negotiation-socket-support.ts

## Measured pure production LOC

Compared with merged S16 base 629c344bb2b82fe53299ef265e365b140ca4bb1f; comments and blank lines excluded using parsed comment ranges. S17 adds 352 pure production lines in the git diff, counting every new-module line and every added existing-file line, including all moved code. Positive per-file deltas total 288. No moved-line deduction is needed to satisfy 550. All already-oversized owners have nonpositive deltas, and every other file remains below 250.

| File (packages/coding-agent/) | Before | After | Delta |
| --- | ---: | ---: | ---: |
| `scripts/fragment-record-fixtures.ts` | 222 | 222 | 0 |
| `scripts/fragment-record-index.ts` | 30 | 29 | -1 |
| `scripts/fragment-record-source.ts` | 74 | 74 | 0 |
| `src/core/agent-session.ts` | 11371 | 11370 | -1 |
| `src/main.ts` | 1407 | 1406 | -1 |
| `src/modes/rpc/attachment-types.ts` | 38 | 39 | 1 |
| `src/modes/rpc/compact-admission-reply.ts` | 18 | 33 | 15 |
| `src/modes/rpc/compact-admission-validation.ts` | 57 | 58 | 1 |
| `src/modes/rpc/compact-open-admission.ts` | 132 | 132 | 0 |
| `src/modes/rpc/connection-handler.ts` | 1891 | 1891 | 0 |
| `src/modes/rpc/host-capabilities.ts` | 109 | 113 | 4 |
| `src/modes/rpc/host-warm.ts` | 129 | 130 | 1 |
| `src/modes/rpc/rpc-response-types.ts` | 13 | 20 | 7 |
| `src/modes/rpc/session-attachment-commands.ts` | 134 | 148 | 14 |
| `src/modes/rpc/session-event-fanout.ts` | 245 | 247 | 2 |
| `src/modes/rpc/session-event-writer-connections.ts` | 160 | 163 | 3 |
| `src/modes/rpc/session-event-writer-destinations.ts` | 106 | 118 | 12 |
| `src/modes/rpc/session-event-writer.ts` | 229 | 234 | 5 |
| `src/modes/rpc/session-registry.ts` | 164 | 166 | 2 |
| `src/modes/rpc/session-router-context.ts` | 116 | 116 | 0 |
| `src/modes/rpc/session-router-host-reads.ts` | 64 | 68 | 4 |
| `src/modes/rpc/session-router-routing.ts` | 239 | 227 | -12 |
| `src/modes/rpc/session-worker-client.ts` | 506 | 500 | -6 |
| `src/modes/rpc/session-worker-protocol.ts` | 160 | 163 | 3 |
| `src/modes/rpc/session-worker.ts` | 364 | 362 | -2 |
| `src/modes/rpc/structured-session-records.ts` | 111 | 109 | -2 |
| `src/modes/rpc/worker-session-registry.ts` | 242 | 243 | 1 |
| `src/modes/rpc/compact-negotiation.ts` | 0 | 89 | 89 |
| `src/modes/rpc/compact-runtime-factory.ts` | 0 | 7 | 7 |
| `src/modes/rpc/compact-socket-commands.ts` | 0 | 68 | 68 |
| `src/modes/rpc/worker-admission-command.ts` | 0 | 19 | 19 |
| `src/modes/rpc/worker-client-capabilities.ts` | 0 | 30 | 30 |

The brief-listed `node scripts/changes-md-check.mjs --staged` was attempted and exited 1 with MODULE_NOT_FOUND: that script is absent in the merged S16 base. `audit-changes-md.mjs` is the pin audit and has no staged mode. The actual PR changelog gate includes the per-runtime-path tracker audit; its result is reported separately. The complete staged root check (lint/ratchet, format, lock/pin/import/entry-graph checks and both typecheck graphs) passed.
