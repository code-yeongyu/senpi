# TODO15 Stop-Hook Verification 2

Recorded: 2026-07-06T16:29:36Z
Worktree: /Volumes/mengmotaStorage/local-workspaces/senpi-wt/senpi-mcp-plugin-w2

## Current Git State

```
## code-yeongyu/senpi-mcp-plugin-w2
?? .omo/evidence/task-15-stop-hook-verification-2.md
?? .omo/evidence/task-16-stop-hook-verification-2.md
?? .omo/evidence/task-16-stop-hook-verification-3.md
?? .omo/evidence/task-16-stop-hook-verification.md
?? .omo/evidence/todo-14-stop-hook-verification-2.md
?? .omo/evidence/todo-14-stop-hook-verification.md
```

## Recent Commits

```
16e30dafa2c74fb4aed8d70e7e86ab3c32ae1f15 docs(coding-agent): add todo15 stop-hook evidence
e485e72dac2b778358b48f884f12bfec151fa3d6 feat(coding-agent): add mcp startup race hot-swap
52ea03edf3059e121f77d8e7aae90f817219fb79 docs(coding-agent): add mcp cache and ping gate evidence
```

## Verify Claimed Commits Exist

```
commit
commit
```

## Verify Tracked TODO15 Receipt Is In HEAD

```
.omo/evidence/task-15-senpi-mcp-plugin.md
.omo/evidence/task-15-stop-hook-verification.md
packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts
packages/coding-agent/test/mcp/startup-race.test.ts
```

## Evidence Files Non-Empty

```
    2042 .omo/evidence/task-15-senpi-mcp-plugin.md
    9553 .omo/evidence/task-15-stop-hook-verification.md
    2080 local-ignore/qa-evidence/20260706-mcp-w2-todo15/INDEX.md
  406380 local-ignore/qa-evidence/20260706-mcp-w2-todo15/happy-rpc-transcript.json
  418636 local-ignore/qa-evidence/20260706-mcp-w2-todo15/failure-rpc-transcript.json
     201 local-ignore/qa-evidence/20260706-mcp-w2-todo15/auth-isolation.txt
     108 local-ignore/qa-evidence/20260706-mcp-w2-todo15/cleanup.txt
```

## Manual QA Bundle Spot Checks

```
local-ignore/qa-evidence/20260706-mcp-w2-todo15/cleanup.txt:1:happy fixture pid 13594 dead=true sandboxRemoved=true
local-ignore/qa-evidence/20260706-mcp-w2-todo15/cleanup.txt:2:wedge fixture pid 13982 dead=true sandboxRemoved=true
local-ignore/qa-evidence/20260706-mcp-w2-todo15/INDEX.md:7:- Happy path: RPC real CLI from source, warm cache, slow fixture. First provider request arrived in 52ms and returned TODO15_IMMEDIATE_OK while fixture was still connecting; later request exposed mcp_fx_tool_2 and tool result reached the model.
local-ignore/qa-evidence/20260706-mcp-w2-todo15/INDEX.md:8:- Failure path: RPC real CLI from source, warm cache, wedged fixture. Cached mcp_fx_tool_1 stayed visible; tool call completed in 589ms with model-visible ConnectError; get_state succeeded afterward.
local-ignore/qa-evidence/20260706-mcp-w2-todo15/INDEX.md:9:- Auth isolation: auth-isolation.txt records unchanged real auth hash.
local-ignore/qa-evidence/20260706-mcp-w2-todo15/INDEX.md:10:- Cleanup: cleanup.txt records fixture process death; no tmux sessions were created by this QA driver; model servers were closed and sandboxes removed.
local-ignore/qa-evidence/20260706-mcp-w2-todo15/auth-isolation.txt:4:unchanged=true
```

## Focused TODO15 Test Rerun

Command: cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/startup-race.test.ts

```

 RUN  v4.1.9 /Volumes/mengmotaStorage/local-workspaces/senpi-wt/senpi-mcp-plugin-w2/packages/coding-agent

······

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  01:29:37
   Duration  5.46s (transform 1.06s, setup 11ms, import 1.71s, tests 3.65s, environment 0ms)

```

## Impacted MCP Suite Rerun

Command: cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/catalog-cache.test.ts test/mcp/register-call.test.ts test/mcp/service-lifecycle.test.ts test/mcp/connection.test.ts test/mcp/ping-on-call.test.ts

```

 RUN  v4.1.9 /Volumes/mengmotaStorage/local-workspaces/senpi-wt/senpi-mcp-plugin-w2/packages/coding-agent

·································

 Test Files  5 passed (5)
      Tests  33 passed (33)
   Start at  01:29:43
   Duration  3.96s (transform 3.51s, setup 65ms, import 6.14s, tests 9.74s, environment 0ms)

```

## Root Check Rerun

Command: npm run check

```

> check
> biome check --write --error-on-warnings . && npm run check:pinned-deps && npm run check:ts-imports && npm run check:shrinkwrap && npm run check:install-lock:coding-agent && tsgo --noEmit && node scripts/check-browser-smoke.mjs && node scripts/run-web-ui-check.mjs && npm run check:neo

Checked 1436 files in 770ms. No fixes applied.

> check:pinned-deps
> node scripts/check-pinned-deps.mjs


> check:ts-imports
> node scripts/check-ts-relative-imports.mjs


> check:shrinkwrap
> node scripts/generate-coding-agent-shrinkwrap.mjs --check

packages/coding-agent/npm-shrinkwrap.json is up to date.

> check:install-lock:coding-agent
> node scripts/generate-coding-agent-install-lock.mjs --check

packages/coding-agent/install-lock is up to date.

> @earendil-works/pi-web-ui@2026.7.5-2 check
> biome check --write --error-on-warnings . && tsc --noEmit && npm run check --prefix example

Checked 67 files in 30ms. No fixes applied.

> pi-web-ui-example@0.75.3 check
> tsgo --noEmit


> check:neo
> node scripts/check-neo.mjs

check:neo: go build ./...
check:neo: go vet ./...
check:neo: go test ./...
ok  	github.com/code-yeongyu/senpi/packages/neo/cmd/senpi-neo	(cached)
?   	github.com/code-yeongyu/senpi/packages/neo/internal/app	[no test files]
ok  	github.com/code-yeongyu/senpi/packages/neo/internal/bridge	12.765s
?   	github.com/code-yeongyu/senpi/packages/neo/internal/bridge/attachqa	[no test files]
ok  	github.com/code-yeongyu/senpi/packages/neo/internal/store	(cached)
ok  	github.com/code-yeongyu/senpi/packages/neo/internal/store/clipboard	(cached)
?   	github.com/code-yeongyu/senpi/packages/neo/internal/store/qaharness	[no test files]
?   	github.com/code-yeongyu/senpi/packages/neo/internal/store/writeqa	[no test files]
ok  	github.com/code-yeongyu/senpi/packages/neo/internal/theme	(cached)
ok  	github.com/code-yeongyu/senpi/packages/neo/internal/ui	(cached)
ok  	github.com/code-yeongyu/senpi/packages/neo/internal/ui/builtinext	(cached)
?   	github.com/code-yeongyu/senpi/packages/neo/internal/ui/builtinext/qaharness	[no test files]
ok  	github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor	(cached)
?   	github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor/qaharness	[no test files]
?   	github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor/textwidth	[no test files]
ok  	github.com/code-yeongyu/senpi/packages/neo/internal/ui/extui	(cached)
?   	github.com/code-yeongyu/senpi/packages/neo/internal/ui/extui/qaharness	[no test files]
ok  	github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings	(cached)
?   	github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings/qaharness	[no test files]
ok  	github.com/code-yeongyu/senpi/packages/neo/internal/ui/markdown	(cached)
?   	github.com/code-yeongyu/senpi/packages/neo/internal/ui/markdown/qaharness	[no test files]
ok  	github.com/code-yeongyu/senpi/packages/neo/internal/ui/overlays	(cached)
?   	github.com/code-yeongyu/senpi/packages/neo/internal/ui/overlays/qaharness	[no test files]
?   	github.com/code-yeongyu/senpi/packages/neo/internal/ui/qaharness	[no test files]
ok  	github.com/code-yeongyu/senpi/packages/neo/internal/ui/shell	(cached)
?   	github.com/code-yeongyu/senpi/packages/neo/internal/ui/shell/qaharness	[no test files]
ok  	github.com/code-yeongyu/senpi/packages/neo/internal/ui/slash	(cached)
?   	github.com/code-yeongyu/senpi/packages/neo/internal/ui/slash/qaharness	[no test files]
ok  	github.com/code-yeongyu/senpi/packages/neo/internal/ui/transcript	(cached)
?   	github.com/code-yeongyu/senpi/packages/neo/internal/ui/transcript/qaharness	[no test files]
ok  	github.com/code-yeongyu/senpi/packages/neo/internal/ui/transcript/terminalimage	(cached)
check:neo: packages/neo build+vet+test passed
```

## Judgment

PASS: second stop-hook verification independently re-ran focused TODO15 tests, impacted MCP suites, and root check; claimed commits and evidence files exist; manual QA bundle contains auth and cleanup receipts.
