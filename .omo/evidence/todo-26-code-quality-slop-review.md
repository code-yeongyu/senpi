# TODO26 Code Quality / Slop Review

Task: Bearer/header auth path + autodetect rules + fingerprint logging.

Changed files reviewed:
- `packages/coding-agent/src/core/extensions/builtin/mcp/transport.ts`
- `packages/coding-agent/test/mcp/auth-modes.test.ts`
- `.omo/evidence/task-26-senpi-mcp-plugin.log`

Review checklist:
- Behavior is covered by RED/GREEN tests in `test/mcp/auth-modes.test.ts`.
- `bearerTokenEnv` now attaches Authorization when implicit bearer mode is selected.
- Explicit `auth: false` remains an override and does not require or attach bearer env auth.
- No raw auth material appears in task evidence or local QA bundle; only 8-character fingerprints are present.
- No unrelated TODO27 race fixture, plan checkbox, `.omo/boulder.json`, or unrelated evidence files were edited.
- Touched source file pure LOC: `transport.ts` 249, `auth-modes.test.ts` 136.
- `npm run check` passed after the final source shape with no formatter changes.

UltraQA probes:
- malformed_input: unset `bearerTokenEnv` fails during transport creation with env var named.
- stale_state: env value is resolved per transport creation; changed env on next connect is observed.
- dirty_worktree: unrelated untracked `.omo/evidence/subagent-stop-*` files were left untouched.
- hung_or_long_commands: no hung commands; all test/check/QA commands exited 0.
- flaky_tests: focused auth/transport tests were rerun after cleanup edits.
- misleading_success_output: RED captured the real missing-header 401 before fix; GREEN reran acceptance.
- prompt_injection/untrusted text logging: literal header value warning logs fingerprint only, no raw token.
- cancel_resume/repeated_interruptions: N/A; no resumable state machine changed.

Residual risks:
- `transport.ts` is at 249 pure LOC, close to the plan ceiling; future transport work should split rather than grow it.
- Manual QA uses local fixtures, not a third-party remote API-key server; this is intentional to avoid real credentials and paid/network dependencies.
