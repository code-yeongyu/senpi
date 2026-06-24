# PR-010 Reconnect/Resume Durability

This work is using code-yeongyu/lazycodex teammode.

## Summary

PR-010 adds the scoped reconnect/resume durability layer for the pi Codex app-server adapter. The adapter now has an opaque resume token format, snapshot reload through app-server `thread/resume`, `thread/read`, `thread/turns/list`, and `thread/turns/items/list`, replay cursor updates from terminal notifications, duplicate terminal protection, disconnect control events, and pending callback replay/rejection hooks.

Review follow-up: terminal replay cursor updates now parse the real app-server `turn/completed` payload shape (`{ thread_id, turn: { id } }` / `{ threadId, turn: { id } }`) and preserve existing replay cursor fields when a completion event has no item id.

Scope intentionally excludes PR-011 realtime/filesystem/plugin/config, PR-012 redaction QA, and PR-013 final compatibility evidence packet.

## Behavior

- Resume tokens encode external session id, authoritative app-server thread/session ids, and the replay cursor.
- Reconnect emits explicit `disconnect` and `resume` control surfaces and claims only `snapshot-plus-new-stream`, never exact lost-delta replay.
- Snapshot reload preserves app-server IDs and injects replay cursors as `after_turn_id` and `after_item_id`.
- Tombstoned external sessions reject resume before any app-server call.
- Duplicate terminal notifications are suppressed so replay cursors are advanced only once per app-server turn.
- Pending callbacks can be replayed to the external side or rejected back to app-server during reconnect.

## Verification

- `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-010-reconnect/failing-first.txt`: new reconnect test failed before `reconnect-resume.ts` existed.
- `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-010-reconnect/failing-first-review-fix.txt`: focused review regressions failed before the parser/cursor merge fix.
- `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-010-reconnect/targeted-reconnect-review-fix-final.txt`: focused reconnect/review regression suite passed, 2 files / 6 tests.
- `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-010-reconnect/targeted-pr010-review-fix-final.txt`: focused PR-001 through PR-010 suite passed, 10 files / 40 tests.
- `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-010-reconnect/npm-run-check-final.txt`: `npm run check` passed.
- `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-010-reconnect/npm-run-check-review-fix-final.txt`: `npm run check` passed after the review fix.
- `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-010-reconnect/typescript-no-excuse-audit.txt`: TypeScript no-excuse audit passed.
- `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-010-reconnect/typescript-no-excuse-audit-review-fix-final.txt`: TypeScript no-excuse audit passed after the review fix.
- `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-010-reconnect/senpi-qa-common-self-check.txt`: senpi QA common self-check passed 9/9 with real auth unchanged.
- `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-010-reconnect/senpi-qa-common-self-check-review-fix-final.txt`: senpi QA common self-check passed 9/9 after the review fix.
- `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-010-reconnect/senpi-qa-cli-smoke.txt`: CLI smoke passed 5/5 with real auth unchanged.
- `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-010-reconnect/senpi-qa-cli-smoke-review-fix-final.txt`: CLI smoke passed 5/5 after the review fix.
- `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-010-reconnect/senpi-qa-mock-loop.txt`: mock loop passed 5/5 with localhost fake providers and real auth unchanged.
- `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-010-reconnect/senpi-qa-mock-loop-review-fix-final.txt`: mock loop passed 5/5 after the review fix.
- `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-010-reconnect/drive-adapter-help.txt`: adapter harness help smoke passed.
- `.omo/evidence/20260624-pi-codex-app-server-execution/pr-010-reconnect/15-resume-rejoin-reconnect.sanitized.jsonl`: scenario 15 sanitized transcript.

## Project Tracking

`BLOCKED:missing-gh-project-scope` remains recorded. `gh project list --owner code-yeongyu --format json --limit 20` requires `read:project`, so GitHub Project status cannot be updated from this token. Artifact: `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-010-reconnect/gh-project-list.txt`.

## Residual Risks

See `residual-risks.md`.
