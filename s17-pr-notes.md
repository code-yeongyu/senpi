# S17 local delivery (part of #4272)

## Scope and binding decisions

RULING-98 digest correction: b3bf76cea0bb0afc5adde3e968117ae45496ed7d. Separate index-description fold: aa30b6902fe74751e4b2ea62ef6b4dc052eaccdb. Latest base merged from origin/feat/4272-s16-consumer at 23839c09be69e186e9dfea73997e3566bb0ed3bf (merge d0cfdf97567b9593ad3d66665945d76075daca3f). This preserves the restored SessionWorkerClient.request() delegate and relocated SessionWorkerCallbacks. Desktop agreement is a merge prerequisite owned separately, not a local execution wait. Nothing pushed.

## Contract evidence

| Contract | RED | GREEN evidence |
| --- | --- | --- |
| RULING-98 / R4.B3 / T1 | Raw SHA-256 goldens disagreed with all 21 producer fragments; production-codec verifier failed 12 tests. | Fragment fixture verifier 18/18; production producePage compared exact offsets, lengths, next/complete, pinned data and codec digests in all 8 valid cases. The independent receiver verifier also covers digest-mismatch, stale-ref and out-of-order-offset (all 11 shared cases). |
| T7 / RULING-66 / RULING-73 | Actual socket lacked advertisement and ACK pair, accepted pre-selection admission and downgrade. | Actual TCP declarations and admissions, plus 16 shared client-info-ack cases (exact ACK records plus discovery pair projections), verify OFF/no-data ACK, ON paired selection, repeated and omitted declarations, session ownership, independent flags, rejected downgrade/incomplete pair, no-ID heartbeat and reconnect. |
| T2 / X06 | Compact attach was rejected by the old unknown-admission guard. Worker session ACK was received privately but discarded because request ALS did not cross the isolate. | Attach/reset/required mirror test passes through S15 admission, and worker ACK reaches its actual socket after bounded identity scope crosses private frames. No retained request lookup index. |
| OFF / old RpcClient | Discovery-only capability delta made the old ON-versus-OFF equality stale. | Exact OFF h-legacy golden remains unchanged; the existing real RpcClient test separately asserts the ON discovery pair and then compares every other request/frame byte. Internal capture and worker transport are unconditional. |

The production fixture normalization check removed digest-named keys and found an empty normalized JSON diff across 12 files; later digestRule prose was changed only under the owner's separate D17 fold. The d-before-answer admission golden was regenerated for the new explicit selection prelude; a/b/c/e/g and h-legacy remain unchanged.

## Implementation

The socket registration owns one CompactSelection. Validation precedes roles, pending capabilities and writer mutation. Legacy format freezes only on content-producing admission; status-only observation does not freeze it. A rejected first compact selection cannot fall through to an open. Complete factory support is explicit; unknown/external factories default unsupported and mixed factories can reject a profile before any physical hold. Classic discovery filters inherited compact tokens and refuses direct compact selection. New peers get new registration state.

Host and session declarations use the same preflight. Worker capability callbacks may acknowledge only host-accepted capability state. Private worker frames carry only reply identity, not a duplicate command body; the original request scope is restored during publication, so stale ownership remains subject to the existing admission check. Selected control ACKs stay correlated controls at final encoding. Required mirrors fail closed on a future lane-less match.

The OFF private-capture test also went RED because AgentSession still gated its private recovery identity on the public rollout flag. Making the upstream identity unconditional restored canonical carrier ownership; the actual private worker observer now proves capture and transport under both flag states without asking a raw socket to retain unconsumed compact leases.

## Validation commands

All commands use Node 24, CI=1, nice -n 10, task TMPDIR and the five brief-listed session variables removed. Tests run one file per invocation with --no-file-parallelism; no wide suite. Root build/check and the PR changelog gate are the available final checks. The requested staged checker is absent, as recorded below; see the final report for exact outputs. The numeric fragment changes/unreleased/4272.md is used because the gate rejects the requested nonnumeric s17.md name.

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

Base: 23839c09be69e186e9dfea73997e3566bb0ed3bf. Parsed comment ranges and blank lines excluded. S17 adds 361 pure production lines in the git diff, INCLUDING every moved line and every new-module line; no moved-line deduction is needed to satisfy 550. Every already-oversized owner has a nonpositive delta; all other production files remain <=250.

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
| `src/modes/rpc/session-router-context.ts` | 116 | 121 | 5 |
| `src/modes/rpc/session-router-host-reads.ts` | 64 | 68 | 4 |
| `src/modes/rpc/session-router-routing.ts` | 239 | 230 | -9 |
| `src/modes/rpc/session-worker-client.ts` | 497 | 491 | -6 |
| `src/modes/rpc/session-worker-protocol.ts` | 160 | 163 | 3 |
| `src/modes/rpc/session-worker.ts` | 364 | 362 | -2 |
| `src/modes/rpc/structured-session-records.ts` | 111 | 109 | -2 |
| `src/modes/rpc/worker-session-registry.ts` | 242 | 243 | 1 |
| `src/modes/rpc/compact-negotiation.ts` | 0 | 89 | 89 |
| `src/modes/rpc/compact-runtime-factory.ts` | 0 | 7 | 7 |
| `src/modes/rpc/compact-socket-commands.ts` | 0 | 68 | 68 |
| `src/modes/rpc/worker-admission-command.ts` | 0 | 19 | 19 |
| `src/modes/rpc/worker-client-capabilities.ts` | 0 | 30 | 30 |

The requested `node scripts/check-changes-md.mjs --staged` was attempted and exited 1 with MODULE_NOT_FOUND: the script is absent from the merged S16 base. The earlier changes-md-check.mjs spelling is also absent. The repository implements tracker policy in check-pr-changelog.mjs; its actual PASS is quoted in the final report. Root check covers lint/ratchet, format, locks/pins/imports/entry graphs and both typecheck graphs.

## Ruling traceability

| Ruling / claim | Implementation | Observable test |
| --- | --- | --- |
| RULING-44/98: one shared fragment byte contract | `scripts/fragment-record-fixtures.ts`, `src/modes/rpc/compact-catalog-codec.ts:47`, unchanged `fixtures/fragment-records/` from aa30b6902f | fragment-record-fixtures (18 cases) and negotiated-fragments (8 producer cases) |
| RULING-66 Q1=A: truthful flag-gated public support, unconditional private capture/transport | `src/modes/rpc/compact-negotiation.ts:62`, `session-router-host-reads.ts`, `structured-session-records.ts`, `core/agent-session.ts` | socket OFF/ON discovery and actual private worker capture/transport |
| RULING-66 Q2=A: complete owner only, mixed profiles refused before holds | `src/modes/rpc/compact-socket-commands.ts:37`, `session-registry.ts`, `compact-runtime-factory.ts` | admission mixed-profile spy proves zero physical opens; unsupported-factory discovery and pair refusal |
| RULING-70(2): manifest on selected wire, same page route | `src/modes/rpc/compact-open-admission.ts:94`, `session-router-routing.ts` get_recovery_page route, existing `src/modes/rpc/recovery-page-command.ts:53` | socket T7/T2 subscribes to recovery_manifest before open, then pages manifest via get_recovery_page and verifies its production fragment digest; existing admission-open golden c |
| RULING-73: accepted pair at data.capabilities, no id means no reply | `src/modes/rpc/compact-negotiation.ts:67`, writer control encoder | fixtures/client-info-ack/index.json and all 16 runtime cases |

The final T7 fold went RED with inherited compact_events surviving on an unselected actual socket, then GREEN after stripping launch/private opt-ins and forwarding only host-validated declarations. The session route is covered too. Graceful TCP teardown subscribes to close before ending clients, avoiding the owned test failure-path reset. The role-refusal latch also prevents a failed first compact selection from reverting to implicit legacy admission.

## Shared fixture cases

| Fragment case | Required observed result |
| --- | --- |
| empty-field | exact producer fragments and independent receiver acceptance |
| single-small | exact producer fragments and independent receiver acceptance |
| exact-D | exact producer fragments and independent receiver acceptance |
| D-plus-1 | exact producer fragments and independent receiver acceptance |
| multi-fragment-over-S | exact producer fragments and independent receiver acceptance |
| utf8-split | exact producer fragments and independent receiver acceptance |
| nul-bytes | exact producer fragments and independent receiver acceptance |
| json-escape-split | exact producer fragments and independent receiver acceptance |
| digest-mismatch | independent receiver rejection |
| stale-ref | independent receiver rejection |
| out-of-order-offset | independent receiver rejection |

D02 shared ACK fixtures use the AGREED `docs/engine-socket/fixtures/client-info-ack/<case-id>.json` path and `{contractIds,request,flag,expectedAck}` fields. The index names all 16 cases; the engine never sends a partial accepted pair, so partial-pair is a typed refusal, explicitly documented in the index. Relocation edits preserve the pair. No fragment-record bytes were changed for this fold. No open local contract decisions remain; the separately owned desktop agreement is still a merge prerequisite, not a wait for this local task.
