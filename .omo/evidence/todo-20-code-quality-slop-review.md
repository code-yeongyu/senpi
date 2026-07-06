# TODO20 code-quality and slop review

Scope:
- `packages/coding-agent/src/core/extensions/builtin/mcp/catalog.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/config-schema.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/session.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/guard/output-guard.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`
- `packages/coding-agent/test/mcp/output-guard.test.ts`
- `packages/coding-agent/test/mcp/fixtures/options.ts`
- `packages/coding-agent/test/mcp/fixtures/sdk-server.ts`

Programming review:
- Guard behavior runs before model payload assembly by applying `guardMcpCallToolResult()` in the MCP tool registration path.
- Spill files are written under the agent temp directory with mode `0600`, tracked by path, and cleaned by `cleanupMcpOutputArtifacts()` on service disposal.
- Binary outputs are summarized by mime type, byte count, and artifact path without sending raw binary content to the model.
- LOC: `.omo/evidence/task-19-task-20-loc-audit.log` shows all TODO20 files at or below 250 pure LOC; largest files are `sdk-server.ts` at 242 and `service.ts` at 239.
- TypeScript escape hatches: no `any`, `as any`, `@ts-ignore`, or `@ts-expect-error` were added in TODO20 files.

Remove-ai-slops review:
- No hollow tests: `output-guard.test.ts` covers byte and line truncation, binary spill, unique concurrent artifact names, cleanup, `isError` passthrough, and unwritable fallback.
- No speculative abstraction: output guarding is isolated under `mcp/guard/` and is called only at MCP tool/resource output boundaries.
- No broad catch-and-swallow: artifact write failures degrade to compact inline summaries instead of hiding the tool result.
- No dead/debug code: no console/debug leftovers in production code.

Verification artifacts:
- Focused tests: `.omo/evidence/task-20-senpi-mcp-plugin-green-output-guard.log`
- Impacted tests: `.omo/evidence/task-20-senpi-mcp-plugin-impacted.log`
- Root check: `.omo/evidence/task-20-senpi-mcp-plugin-check.log`
- LOC audit: `.omo/evidence/task-19-task-20-loc-audit.log`
- Manual QA: `local-ignore/qa-evidence/20260707-mcp-w2-todo19-todo20/INDEX.md`

Residual risk:
- None known for TODO20.
