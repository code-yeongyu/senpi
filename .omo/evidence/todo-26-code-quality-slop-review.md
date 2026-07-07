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

Required overfit/slop checklist:
- `any` / inline imports / non-erasable TS: PASS. Static review of the TODO26 changed TS files found no `any`, `as any`, `as unknown`, dynamic `import()`, inline type imports, `enum`, `namespace`/`module`, parameter properties, `import =`, `export =`, `@ts-ignore`, or `@ts-expect-error`.
- Unwrapped async / catch-swallow: PASS. The only ignored promise rejections are shutdown/dispose best-effort paths after a primary connect failure or cleanup path has already been established; they do not hide the connect result under test. No new empty catch blocks or broad async wrappers were introduced for TODO26 behavior.
- Secret logging: PASS. Auth-bearing MCP logs pass through `redactMcpLogText`/structured redaction and emit only `<redacted:xxxxxxxx>` or `fp xxxxxxxx` fingerprints. Evidence scans cover the known TODO26 sentinel values and found no raw token bytes.
- SDK misuse: PASS. HTTP MCP transport still uses `StreamableHTTPClientTransport` with SDK `authProvider` only when OAuth is resolved. Header/bearer auth is supplied through `requestInit.headers`; the change avoids OAuth discovery/DCR for API-key header servers instead of bypassing the SDK.
- Dead config fields: PASS. `auth`, `headers`, and `bearerTokenEnv` are all consumed by auth-mode resolution and transport header construction; no unused TODO26 config knobs or stale schema fields were left behind.
- Module LOC >250: PASS with risk. `transport.ts` measures 249 pure LOC and `auth-modes.test.ts` measures 136 pure LOC, so neither exceeds the hard ceiling. `transport.ts` is in the warning band and should be split before future behavior growth.
- Naming/convention drift: PASS. Names follow existing MCP config/transport vocabulary (`auth`, `bearerTokenEnv`, `headers`, `resolveAuthMode`, `createMcpTransport`) and do not introduce parallel naming families or one-off abstractions.
- Hollow tests / mock-only assertions: PASS. Tests drive observable behavior through fixture HTTP/OAuth servers, real `ServerConnection`/transport creation, logger output, and client tool listing. They do not only assert object existence, mirror implementation constants, or pass solely because a mock returns the expected value.
- TODO27 scope creep: PASS. Scope scans found no TODO27 response-side tool search/status-header work, `stubSwap`, `nativeToolSearch`, `after_provider_response`, or unrelated status/headers changes in the TODO26 source/test diff.

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
