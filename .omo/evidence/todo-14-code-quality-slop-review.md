# TODO14 code-quality and slop review

Date: 2026-07-07
Worktree: `/Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w2`
Branch: `code-yeongyu/senpi-mcp-plugin-w2`

## Fix scope

- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`
  now forces `lifecycle: "eager"` servers to connect and refresh cache
  metadata even when a valid warm cache exists.
- `packages/coding-agent/src/core/extensions/builtin/mcp/catalog-cache.ts`
  removes the no-excuse `as unknown` assertion by assigning parsed JSON to
  an `unknown` variable.
- `packages/coding-agent/test/mcp/catalog-cache.test.ts` adds the behavioral
  eager warm-cache mismatch regression.

No plan checkbox or ledger file was modified. Raw QA artifacts remain ignored
under `local-ignore/qa-evidence/`; no raw prompt, AGENTS payload, token, auth
header, cookie, or credential material is committed here.

## TDD evidence

RED command:

```text
cd packages/coding-agent &&
npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/catalog-cache.test.ts
```

RED observable: the new eager mismatch test failed before the implementation
because the eager server did not spawn; `readCounter()` raised `ENOENT` for
`eager-spawns.txt`. The captured run reported `1 failed | 5 passed` and
`exit_code=1`.

GREEN command:

```text
cd packages/coding-agent &&
npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/catalog-cache.test.ts
```

GREEN observable: `1 passed` test file, `6 passed` tests. The eager mismatch
case observed one fixture spawn, registered `mcp_fx_tool_1` and
`mcp_fx_tool_2`, rejected `mcp_fx_stale_cached`, and rewrote
`mcp-cache.json` to `["tool_1", "tool_2"]`.

## Verification

Impacted MCP tests:

```text
cd packages/coding-agent &&
npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/*.test.ts
```

Result: `16 passed` test files, `106 passed` tests.

No-excuse TypeScript check:

```text
NODE_PATH=/Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w2/node_modules \
npx tsx /Users/yeongyu/.agents/skills/programming/scripts/typescript/check-no-excuse-rules.ts \
packages/coding-agent/src/core/extensions/builtin/mcp/service.ts \
packages/coding-agent/src/core/extensions/builtin/mcp/catalog-cache.ts \
packages/coding-agent/test/mcp/catalog-cache.test.ts
```

Result: `No violations in 3 file(s).`

Root check:

```text
npm run check
```

Result: exited 0. Biome, pinned deps, TS import checks, shrinkwrap/install-lock
checks, `tsgo --noEmit`, browser smoke, web UI check, and `check:neo` all
passed.

## Manual QA

Fresh W2 real-surface QA command:

```text
node /tmp/senpi-mcp-cache-qa-todo14-fix.mjs
```

Captured artifacts:

- `local-ignore/qa-evidence/20260707-mcp-w2-todo14-fix/INDEX.md`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo14-fix/warm-observables.json`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo14-fix/poison-observables.json`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo14-fix/isolation-receipt.json`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo14-fix/cleanup-receipt.json`

Manual QA observables:

- Warm cache RPC startup did not spawn the fixture before first tool call
  (`spawnBeforeCall: null`), then lazy-connected on the cached tool call
  (`spawnAfterCall: 1`).
- The model saw the fixture result (`modelSawFixtureResult: true`), proving the
  cached direct tool path still drives the real CLI/RPC surface.
- Poisoned 999-tool cache was replaced by the real one-tool catalog
  (`fakeToolPresentAfter: false`, `cacheToolsAfter: ["tool_1"]`).
- Real auth was unchanged (`authUnchanged: true`), and cleanup removed temp
  sandboxes and stopped the fake model server.

Existing W2 raw QA artifacts were preserved at
`local-ignore/qa-evidence/20260706-mcp-w2/`. The new eager-specific behavior is
covered by the focused behavioral regression because the W2 real-surface driver
already proves the cache machinery through the live CLI/RPC surface, while the
regression isolates the only changed lifecycle branch and asserts the cache
rewrite observable directly.

## Slop review

- Overfit check: the fix branches only on the existing normalized
  `server.config.lifecycle === "eager"` value and does not special-case test
  names, fixture paths, tool names, or cache contents.
- Scope check: no unrelated MCP transport, exposure policy, prompt, plan, or
  ledger behavior changed.
- Type-safety check: no `any`, no inline imports, no non-erasable TypeScript
  syntax, and no new suppressions were added.
- Evidence hygiene: committed evidence is concise and sanitized; bulky raw
  request/event artifacts stay ignored under `local-ignore/`.

Residual risk: eager servers now refresh cache on every startup even when the
live catalog matches the warm cache. That is intentional for eager lifecycle
freshness and preserves lazy warm-cache startup behavior.
