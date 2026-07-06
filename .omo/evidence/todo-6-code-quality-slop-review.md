# Todo 6 Fix Code Quality / Slop Review

Scope:

- `packages/coding-agent/src/core/extensions/builtin/mcp/wrap.ts`
- `packages/coding-agent/test/mcp/wrap.test.ts`

## Programming Pass

- No `any` introduced.
- No inline imports introduced in checked TypeScript.
- Erasable TypeScript only: interfaces, functions, and ordinary object narrowing.
- Logger contract now matches the production `McpLogger` shape: `error(message, data?)`.
- Error data is serialized to plain JSON-friendly fields: `name`, `message`, and optional `stack`.
- Existing wrapper behavior is preserved: wrapped callbacks do not reject/crash, `notify` still receives the normalized `Error`, and logger failures still fall back to `console.error`.

## Remove-AI-Slops Pass

- Deletion ladder: no code is dead or speculative. The new serializer is required because production logger redaction/serialization intentionally treats plain `Error` as an object with no enumerable fields.
- Obvious comments: none added.
- Over-defensive code: no broad catch added. Existing logger/notify boundary catches are load-bearing because callbacks must not crash the agent.
- Needlessly complex abstraction: one small serializer is shared by all log paths and avoids duplicating object construction at each call site.
- Duplication/performance: no new repeated work or algorithmic change.
- Oversized modules: unchanged and below the skill threshold for the touched files.

## Overfit Review

- Previous test overfit to `MemoryLogger`, whose `error(scope, Error)` shape preserved `error.message` while production `createMcpLogger().error(message, data?)` wrote `{}`.
- New regression uses real `createMcpLogger`, verifies both ring buffer and file output, and failed RED with the rejected shape:
  `message:"prod.scope", data:{}` with no `prod boom`.
- Existing `MemoryLogger` remains only for wrapper unit behavior; it now adapts the production-compatible `data.message` shape.

## Adversarial Review

- `malformed_input/logger Error object`: covered by RED/GREEN production logger regression and manual safeTimer probe; a raw `Error` object no longer reaches logger data.
- `misleading_success_output`: covered by artifact `local-ignore/qa-evidence/20260706-mcp-task-6-fix/prod-logger-probe.txt`, which inspects actual ring and file output.
- `dirty_worktree/stale_state`: pre-existing dirty files were left unstaged/unmodified; only task-owned files are staged for commit.
- `hung_or_long_commands`: focused test, mock-loop, and `npm run check` all exited normally.
- `flaky_tests`: focused test was run RED and GREEN in the same turn; GREEN passed 9/9.
- Irrelevant classes: network/provider auth exposure is N/A because mock-loop uses localhost fake providers and verified real auth unchanged.

## Residual Risk

Low. The stack string is now present in MCP log data for async wrapper failures. The MCP logger already redacts data recursively before storing ring/file entries, and this change does not add new secret-bearing sources beyond the original thrown error content.
