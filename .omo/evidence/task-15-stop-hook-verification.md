# TODO15 Stop-Hook Verification

Recorded: 2026-07-06T16:27:55Z
Worktree: /Volumes/mengmotaStorage/local-workspaces/senpi-wt/senpi-mcp-plugin-w2

## Git State

```
## code-yeongyu/senpi-mcp-plugin-w2
?? .omo/evidence/task-15-stop-hook-verification.md
?? .omo/evidence/task-16-stop-hook-verification-2.md
?? .omo/evidence/task-16-stop-hook-verification-3.md
?? .omo/evidence/task-16-stop-hook-verification.md
?? .omo/evidence/todo-14-stop-hook-verification-2.md
?? .omo/evidence/todo-14-stop-hook-verification.md
```

## HEAD Commit

```
e485e72dac2b778358b48f884f12bfec151fa3d6
feat(coding-agent): add mcp startup race hot-swap
```

## HEAD Stat

```
e485e72da feat(coding-agent): add mcp startup race hot-swap
 .omo/evidence/task-15-senpi-mcp-plugin.md          |  36 ++++
 .../src/core/extensions/builtin/mcp/connection.ts  |  14 +-
 .../core/extensions/builtin/mcp/expose/register.ts |   6 +-
 .../src/core/extensions/builtin/mcp/service.ts     |  45 ++++-
 .../core/extensions/builtin/mcp/startup-race.ts    |  25 +++
 .../coding-agent/test/mcp/startup-race.test.ts     | 206 +++++++++++++++++++++
 6 files changed, 322 insertions(+), 10 deletions(-)
```

## Evidence Files Non-Empty

```
    2042 .omo/evidence/task-15-senpi-mcp-plugin.md
    2355 .omo/evidence/task-15-senpi-mcp-plugin-red.log
     290 .omo/evidence/task-15-senpi-mcp-plugin-green.log
     359 .omo/evidence/task-15-senpi-mcp-plugin-tests-final.log
    3758 .omo/evidence/task-15-senpi-mcp-plugin-npm-check.log
     498 .omo/evidence/task-15-senpi-mcp-plugin-ts-audit.log
     463 .omo/evidence/task-15-senpi-mcp-plugin-manual-qa.log
    2080 local-ignore/qa-evidence/20260706-mcp-w2-todo15/INDEX.md
  406380 local-ignore/qa-evidence/20260706-mcp-w2-todo15/happy-rpc-transcript.json
  418636 local-ignore/qa-evidence/20260706-mcp-w2-todo15/failure-rpc-transcript.json
     201 local-ignore/qa-evidence/20260706-mcp-w2-todo15/auth-isolation.txt
     108 local-ignore/qa-evidence/20260706-mcp-w2-todo15/cleanup.txt
```

## Manual QA Index

```
# TODO15 Manual QA Evidence

Started: 2026-07-06T16:22:45.616Z
Real auth: /Users/yeongyu/.senpi/agent/auth.json

## Scenarios
- Happy path: RPC real CLI from source, warm cache, slow fixture. First provider request arrived in 52ms and returned TODO15_IMMEDIATE_OK while fixture was still connecting; later request exposed mcp_fx_tool_2 and tool result reached the model.
- Failure path: RPC real CLI from source, warm cache, wedged fixture. Cached mcp_fx_tool_1 stayed visible; tool call completed in 589ms with model-visible ConnectError; get_state succeeded afterward.
- Auth isolation: auth-isolation.txt records unchanged real auth hash.
- Cleanup: cleanup.txt records fixture process death; no tmux sessions were created by this QA driver; model servers were closed and sandboxes removed.

## Artifacts
- /Volumes/mengmotaStorage/local-workspaces/senpi-wt/senpi-mcp-plugin-w2/local-ignore/qa-evidence/20260706-mcp-w2-todo15/happy-rpc-transcript.json
- /Volumes/mengmotaStorage/local-workspaces/senpi-wt/senpi-mcp-plugin-w2/local-ignore/qa-evidence/20260706-mcp-w2-todo15/failure-rpc-transcript.json
- /Volumes/mengmotaStorage/local-workspaces/senpi-wt/senpi-mcp-plugin-w2/local-ignore/qa-evidence/20260706-mcp-w2-todo15/auth-isolation.txt
- /Volumes/mengmotaStorage/local-workspaces/senpi-wt/senpi-mcp-plugin-w2/local-ignore/qa-evidence/20260706-mcp-w2-todo15/cleanup.txt

## Adversarial Classes
- stale_state: warm cache configHash used; happy transcript proves cached tool first, hot-swapped new live tool later.
- dirty_worktree: evidence only under local-ignore; no unrelated worktree files touched by QA.
- hung_or_long_commands: wedge call bounded under 30s.
- misleading_success_output: provider request bodies and RPC events captured, not just pass/fail text.
- flaky_tests: temp sandboxes and local fixtures only.
- malformed_input: wedged non-connecting server covered.
- prompt_injection: NA, no untrusted prompt text handling changed.
- cancel_resume: NA, no cancellation/resume paths touched.
- repeated_interruptions: NA, no interruption/resume paths touched.

```

## Auth And Cleanup Receipts

```
path=/Users/yeongyu/.senpi/agent/auth.json
before=209517649905332ad32411733f098dbc85d7f620e3df5d156720a623b5e052bd
after=209517649905332ad32411733f098dbc85d7f620e3df5d156720a623b5e052bd
unchanged=true
happy fixture pid 13594 dead=true sandboxRemoved=true
wedge fixture pid 13982 dead=true sandboxRemoved=true
```

## Focused TODO15 Test Rerun

Command: cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/startup-race.test.ts

```

 RUN  v4.1.9 /Volumes/mengmotaStorage/local-workspaces/senpi-wt/senpi-mcp-plugin-w2/packages/coding-agent

······

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  01:27:55
   Duration  5.41s (transform 1.04s, setup 11ms, import 1.69s, tests 3.62s, environment 0ms)

```

## Impacted MCP Suite Rerun

Command: cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/catalog-cache.test.ts test/mcp/register-call.test.ts test/mcp/service-lifecycle.test.ts test/mcp/connection.test.ts test/mcp/ping-on-call.test.ts

```

 RUN  v4.1.9 /Volumes/mengmotaStorage/local-workspaces/senpi-wt/senpi-mcp-plugin-w2/packages/coding-agent

·································

 Test Files  5 passed (5)
      Tests  33 passed (33)
   Start at  01:28:01
   Duration  3.89s (transform 3.47s, setup 63ms, import 6.08s, tests 9.53s, environment 0ms)

```

## Root Check Rerun

Command: npm run check

```

> check
> biome check --write --error-on-warnings . && npm run check:pinned-deps && npm run check:ts-imports && npm run check:shrinkwrap && npm run check:install-lock:coding-agent && tsgo --noEmit && node scripts/check-browser-smoke.mjs && node scripts/run-web-ui-check.mjs && npm run check:neo

Checked 1436 files in 746ms. No fixes applied.

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

Checked 67 files in 29ms. No fixes applied.

> pi-web-ui-example@0.75.3 check
> tsgo --noEmit


> check:neo
> node scripts/check-neo.mjs

check:neo: go build ./...
check:neo: go vet ./...
check:neo: go test ./...
ok  	github.com/code-yeongyu/senpi/packages/neo/cmd/senpi-neo	(cached)
?   	github.com/code-yeongyu/senpi/packages/neo/internal/app	[no test files]
ok  	github.com/code-yeongyu/senpi/packages/neo/internal/bridge	(cached)
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

PASS: committed TODO15 implementation exists at HEAD, required evidence files are present and non-empty, focused/impacted tests pass, root check passes, auth isolation and cleanup receipts are present.
