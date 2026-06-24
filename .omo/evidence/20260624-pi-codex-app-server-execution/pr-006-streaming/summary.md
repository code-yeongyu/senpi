# PR-006 Item and Notification Streaming

This work is using code-yeongyu/lazycodex teammode.

## Summary

PR-006 adds the first app-server-to-external projection layer for item and notification streams. It preserves app-server IDs, projects first-class item stream events for text, plan, reasoning, command/process/file/MCP progress, raw response, and terminal turn surfaces, and falls back to lossless opaque `appServer/event` envelopes where no semantic projection exists.

Scope is intentionally limited to PR-006. It does not implement PR-007 backpressure/lag queues, PR-008 server-request callbacks, PR-009 MCP/dynamic tool callback compatibility, PR-010 reconnect, redaction QA, or the final compatibility evidence packet.

## Changed Files

- `packages/coding-agent/src/core/extensions/builtin/pi-codex-app-server/item-stream-projector.ts`
- `packages/coding-agent/src/core/extensions/builtin/pi-codex-app-server/notification-projector.ts`
- `packages/coding-agent/test/suite/pi-codex-app-server-streaming.test.ts`
- `packages/coding-agent/test/suite/pi-codex-app-server-contract.test.ts`

## Evidence

- Failing-first proof: `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-006-streaming/failing-first.txt`
- Focused streaming test: `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-006-streaming/targeted-streaming.txt`
- Adjacent contract/routing/streaming suite: `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-006-streaming/targeted-adjacent-suite-final.txt`
- Full check: `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-006-streaming/npm-run-check-final.txt`
- senpi QA common self-check: `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-006-streaming/senpi-qa-common-self-check.txt`
- senpi QA CLI smoke: `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-006-streaming/senpi-qa-cli-smoke.txt`
- senpi QA mock loop: `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-006-streaming/senpi-qa-mock-loop.txt`
- Adapter harness help smoke: `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-006-streaming/drive-adapter-help.txt`
- Cleanup receipt: `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-006-streaming/cleanup-receipt.txt`
- Commands: `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-006-streaming/commands.txt`

## Assertions Covered

- Text, plan, and reasoning deltas are separate semantic channels.
- `item/started` registers authoritative app-server item IDs in the PR-005 `IdMapper`.
- `item/completed` projects the completed item as authoritative payload.
- Notifications without a first-class projection emit opaque envelopes with original method, original params, app-server IDs, sequence, stream class, and capability flags.
- Negotiated notification opt-outs skip projection before sequence allocation.
- Command, process, file, and MCP progress are classified as best-effort semantic progress without implementing PR-007 drop/lag behavior.

## Project Tracking

`BLOCKED:missing-gh-project-scope` remains. `gh project list --owner code-yeongyu --format json --limit 20` still fails because the token lacks `read:project`.

## Cleanup

No runtime sockets, tmux sessions, browser contexts, containers, or PR-006 temp dirs were left running. The mock loop and fake model server self-tests report real auth unchanged.

## Residual Risks

- Live Codex app-server streaming scenarios `07` and `13` are not fully driven through a protocol route in this PR; PR-006 proves the projection units and keeps harness health green. End-to-end streaming through the adapter remains a later integration/evidence task once the runtime/router surfaces are wired for full event flow.
- Backpressure, lag markers, overload drop accounting, and terminal flush guarantees remain PR-007.
- Server-request callbacks, callback cleanup, and no-auto-approval behavior remain PR-008.
- MCP/dynamic tool callback compatibility remains PR-009.
