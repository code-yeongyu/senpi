# TODO15 Stop-Hook Verification 3

Recorded: 2026-07-07T01:50:00+09:00
Worktree: `/Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w2`
Branch: `code-yeongyu/senpi-mcp-plugin-w2`

## Current Commit Chain

```
abb836a83 fix(coding-agent): keep mcp startup race below line budget
fc0814a9e docs(coding-agent): add todo15 second stop-hook evidence
16e30dafa docs(coding-agent): add todo15 stop-hook evidence
e485e72da feat(coding-agent): add mcp startup race hot-swap
```

## Final TODO15 Commit Contents

Commit: `abb836a83`

```
.omo/evidence/task-15-senpi-mcp-plugin-gate-review.md
.omo/evidence/todo-15-code-quality-slop-review.md
packages/coding-agent/src/core/extensions/builtin/mcp/service.ts
packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts
```

## Fresh Verification After WIP

Focused TODO15 test:

```
Command: cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/startup-race.test.ts
Result: PASS, 1 file / 6 tests
Artifact: .omo/evidence/task-15-senpi-mcp-plugin-tests-final.log
```

Impacted MCP suite:

```
Command: cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/catalog-cache.test.ts test/mcp/register-call.test.ts test/mcp/service-lifecycle.test.ts test/mcp/connection.test.ts test/mcp/ping-on-call.test.ts
Result: PASS, 5 files / 33 tests
Artifact: .omo/evidence/task-15-senpi-mcp-plugin-impacted.log
```

Root check:

```
Command: npm run check
Result: PASS
Artifact: .omo/evidence/task-15-senpi-mcp-plugin-npm-check.log
```

No-excuse audit:

```
Command: TODO15 no-excuse TypeScript/LOC/manual-QA audit
Result: PASS
Artifact: .omo/evidence/task-15-senpi-mcp-plugin-ts-audit.log
```

Pre-commit hook:

```
Command: git commit -m "fix(coding-agent): keep mcp startup race below line budget"
Result: PASS, hook reran npm run check before writing abb836a83
```

## LOC Proof

Captured in `.omo/evidence/task-15-senpi-mcp-plugin-ts-audit.log`:

```
packages/coding-agent/src/core/extensions/builtin/mcp/service.ts pure_loc=230
packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts pure_loc=80
packages/coding-agent/src/core/extensions/builtin/mcp/connection.ts pure_loc=249
packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts pure_loc=174
packages/coding-agent/test/mcp/startup-race.test.ts pure_loc=171
```

`service.ts` is below the required 250 pure LOC ceiling.

## Manual QA Bundle

Bundle: `local-ignore/qa-evidence/20260706-mcp-w2-todo15/`

Non-empty artifacts confirmed:

```
INDEX.md
command-transcript.txt
auth-isolation.txt
cleanup.txt
happy-rpc-transcript.json
failure-rpc-transcript.json
todo15-manual-qa-driver.mjs
```

Scenario markers:

```
happy: PASS - cached first request in 42ms; hot-swap exposed mcp_fx_tool_1,mcp_fx_tool_2
failure: PASS - cached tool stayed visible; ConnectError returned to model in 558ms and RPC stayed responsive
realAuthAfterUnchanged=true
cleanup=complete
```

## Quality Review

Artifacts:

```
.omo/evidence/task-15-senpi-mcp-plugin-gate-review.md
.omo/evidence/todo-15-code-quality-slop-review.md
```

Coverage:

- LOC limit proof for all audited TODO15 TS files.
- No `any`, `as any`, TS suppressions, inline imports, or non-erasable TS syntax.
- Async/timer surfaces reviewed: the single `void connect.then(...)` is the intended bounded late hot-swap path, and refresh failures are caught.
- Stable prompt-cache path verified through sorted registration and byte-identical active tool array coverage.
- Manual QA provenance, auth isolation, cleanup, and secret-safety checks recorded.

## Worktree Boundary

Untracked stop-hook files for TODO14/TODO16 are not staged and are not part of TODO15.
