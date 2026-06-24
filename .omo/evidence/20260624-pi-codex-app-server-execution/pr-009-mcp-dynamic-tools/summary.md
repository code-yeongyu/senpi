# PR-009 MCP And Dynamic Tool Compatibility Evidence

This work is using code-yeongyu/lazycodex teammode.

## Summary

PR-009 adds scoped app-server compatibility for dynamic tool callbacks and MCP
elicitation callbacks. It keeps rich payloads lossless by relaying
`structuredContent`, `content`, and `_meta` through opaque `appServer/request`
envelopes and callback responses instead of flattening them.

## Changed Behavior

- `item/tool/call` is delivered as a pending opaque callback and must be
  explicitly answered with `callback/respond` or `callback/reject`.
- `mcpServer/elicitation/request` is delivered as a pending opaque callback,
  preserving form metadata such as `_meta["openai/form"]`.
- MCP tool progress remains best-effort semantic progress, while completed MCP
  tool items remain lossless and preserve structured content and `_meta`.
- Unsupported app-server callback methods remain explicit
  `invalid-callback-state` errors and are not auto-approved.

## Failing First

`failing-first.txt` shows the new PR-009 targeted suite failed before the fix:
`item/tool/call` and `mcpServer/elicitation/request` returned adapter errors
instead of delivered callbacks, and the unsupported-method copy still named only
PR-008.

## Verification

- Targeted PR-009 MCP/dynamic tool suite: 1 file / 4 tests passed.
- Adjacent app-server suite: 6 files / 28 tests passed.
- `npm run check`: passed.
- senpi QA common self-check: 9/9 passed.
- senpi QA CLI smoke: 5/5 passed.
- senpi QA mock-loop: 5/5 passed.
- Adapter help smoke: passed.
- No-excuse audit: no violations in 3 files.
- `git diff --check`: passed.

## Scenario Artifacts

- `11-dynamic-tool.sanitized.jsonl`
- `12-mcp-tool-and-elicitation.sanitized.jsonl`

Full raw local artifacts remain under:
`local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-009-mcp-dynamic-tools/`.

## Project Tracking

`BLOCKED:missing-gh-project-scope` remains. `gh project list --owner
code-yeongyu --format json --limit 20` reports the token is missing
`read:project`.

## Downstream Unblock Status

PR-010 reconnect/resume remains gated until PR-009 is accepted and merged.
PR-011 realtime/filesystem/plugin/config pass-through, PR-012 redaction QA
harness, and PR-013 final evidence packet remain untouched.
