# TODO19 code-quality and slop review

Scope:
- `packages/coding-agent/src/core/extensions/builtin/mcp/connection.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/diagnose.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/errors.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/health.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts`
- `packages/coding-agent/test/mcp/diagnose.test.ts`
- `packages/coding-agent/test/mcp/fixtures/http-server.ts`
- `packages/coding-agent/test/mcp/fixtures/options.ts`
- `packages/coding-agent/test/mcp/fixtures/stdio-server.ts`

Programming review:
- Typed errors: `SessionExpiredError` is a typed `McpError` kind, and stdio diagnostics flow through existing `ConnectError`.
- TypeScript escape hatches: no `any`, `as any`, `@ts-ignore`, or `@ts-expect-error` were added in TODO19 files.
- LOC: `.omo/evidence/task-19-task-20-loc-audit.log` shows all TODO19 files at or below 250 pure LOC; `connection.ts` is exactly 250 after moving connect-failure formatting into `diagnose.ts`.
- Timer bounds: stdio diagnostic rerun uses `MCP_STDIO_DIAGNOSTIC_TIMEOUT_MS = 5000`, `SIGKILL`, and bounded buffer/output.
- Secret safety: stderr is passed through `redactMcpLogText`; tests and manual QA verify token-like values are redacted.

Remove-ai-slops review:
- No hollow tests: `diagnose.test.ts` fails without recovered stderr/session-expiry behavior and asserts observable error/status text, redaction, timeout bounds, and retry generation.
- No speculative abstraction: `diagnose.ts` owns stdio connect-failure diagnosis only; session-expiry retry stays in `health.ts` with existing connection lifecycle calls.
- No broad catch-and-swallow: JSON log parse failures are intentionally ignored only while scanning diagnostic ring-buffer lines; connect and retry failures remain surfaced as typed errors.
- No dead/debug code: no console/debug leftovers in production code.
- No unnecessary compatibility layer: implementation targets the new TODO19 behavior directly.

Verification artifacts:
- Focused tests: `.omo/evidence/task-19-senpi-mcp-plugin-green-diagnose.log`
- Impacted tests: `.omo/evidence/task-19-senpi-mcp-plugin-impacted.log`
- Root check: `.omo/evidence/task-19-senpi-mcp-plugin-check.log`
- LOC audit: `.omo/evidence/task-19-task-20-loc-audit.log`
- Manual QA: `local-ignore/qa-evidence/20260707-mcp-w2-todo19-todo20/INDEX.md`

Residual risk:
- None known for TODO19.
