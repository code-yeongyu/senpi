# PR-008 Server-Request Callback Bridge Evidence

This work is using code-yeongyu/lazycodex teammode.

## Summary

PR-008 adds the scoped server-request callback bridge for command approval,
file-change approval, permissions approval, and `request_user_input`.

The bridge emits lossless opaque `appServer/request` envelopes, registers
app-server request IDs to external callback IDs, forwards explicit
`callback/respond` and `callback/reject` results back to app-server, rejects
timed-out callbacks, clears mappings on `serverRequest/resolved`, and redacts
secret answers in evidence views. It does not auto-approve privileged requests.

## Changed Behavior

- Command approval requests are delivered as pending callbacks and are not
  answered until an external `callback/respond` arrives.
- File and permissions requests can be explicitly rejected without converting
  rejection into approval.
- `request_user_input` preserves question IDs, `isSecret`, options, and
  `autoResolutionMs`; raw answers still forward to app-server, while committed
  evidence redacts secret answers.
- Unknown, duplicate, late, or timed-out callback responses return
  `invalid-callback-state`.
- `serverRequest/resolved` cleans the callback map and `IdMapper` state.

## Failing First

`failing-first.txt` shows the callback suite failed before implementation:
`Cannot find module ... server-request-bridge.ts`.

Follow-up blocker proof:
`followup-forwarding-retry-failing-first.txt` shows the throwing-client
regressions failed before the fix. Retrying the same `externalCallbackId` after
a synthetic `callbackClient.respond()` or `callbackClient.reject()` failure
returned `invalid-callback-state` instead of remaining retryable.

## Verification

- Targeted PR-008 callback suite: 1 file / 6 tests passed.
- Adjacent app-server suite: 5 files / 23 tests passed.
- `npm run check`: passed.
- senpi QA common self-check: 9/9 passed.
- senpi QA CLI smoke: 5/5 passed.
- senpi QA mock-loop: 5/5 passed.
- Adapter help smoke: passed.
- No-excuse audit: no violations in 4 files.
- `git diff --check`: passed.

## Scenario Artifacts

- `08-command-approval.sanitized.jsonl`
- `09-file-permission-approval.sanitized.jsonl`
- `10-request-user-input.sanitized.jsonl`

## Follow-Up Evidence

The PR-008 review follow-up keeps callback state pending until app-server
forwarding succeeds. The first throwing-client attempt now propagates the
client error without consuming the callback; retrying the same external callback
ID forwards exactly once.

Committed command/result details are in `commands.md`. Full raw local artifacts
for the follow-up use the `followup-forwarding-retry-*` prefix under:
`local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-008-callbacks/`.

Full raw local artifacts remain under:
`local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-008-callbacks/`.

## Project Tracking

`BLOCKED:missing-gh-project-scope` remains. `gh project list --owner
code-yeongyu --format json --limit 20` reports the token is missing
`read:project`.

## Downstream Unblock Status

PR-009 MCP/dynamic tool compatibility remains gated until PR-008 is accepted
and merged. PR-010 reconnect, PR-012 redaction QA harness, and PR-013 final
evidence packet remain untouched.
