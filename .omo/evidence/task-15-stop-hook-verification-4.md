# TODO15 Stop-Hook Verification 4

Recorded: 2026-07-07T01:52:09+09:00
Worktree: /Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w2
Hook run: subagent-stop:22

## Git status before verification

Command: `git status --short --branch`

```
## code-yeongyu/senpi-mcp-plugin-w2
?? .omo/evidence/task-15-stop-hook-verification-4.md
?? .omo/evidence/task-16-stop-hook-verification-2.md
?? .omo/evidence/task-16-stop-hook-verification-3.md
?? .omo/evidence/task-16-stop-hook-verification.md
?? .omo/evidence/todo-14-stop-hook-verification-2.md
?? .omo/evidence/todo-14-stop-hook-verification.md

Exit: 0
```

## Recent TODO15 commits

Command: `git log -8 --oneline --decorate`

```
1bbadf535 (HEAD -> code-yeongyu/senpi-mcp-plugin-w2) docs(coding-agent): add todo15 final stop-hook evidence
abb836a83 fix(coding-agent): keep mcp startup race below line budget
fc0814a9e docs(coding-agent): add todo15 second stop-hook evidence
16e30dafa docs(coding-agent): add todo15 stop-hook evidence
e485e72da feat(coding-agent): add mcp startup race hot-swap
52ea03edf docs(coding-agent): add mcp cache and ping gate evidence
7f2df54e7 docs(coding-agent): add mcp ping health review evidence
70a279105 feat(coding-agent): ping mcp tools before stale calls

Exit: 0
```

## HEAD committed files

Command: `git show --stat --name-only --oneline HEAD`

```
1bbadf535 docs(coding-agent): add todo15 final stop-hook evidence
.omo/evidence/task-15-stop-hook-verification-3.md

Exit: 0
```

## Previous TODO15 fix commit files

Command: `git show --stat --name-only --oneline HEAD~1`

```
abb836a83 fix(coding-agent): keep mcp startup race below line budget
.omo/evidence/task-15-senpi-mcp-plugin-gate-review.md
.omo/evidence/todo-15-code-quality-slop-review.md
packages/coding-agent/src/core/extensions/builtin/mcp/service.ts
packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts

Exit: 0
```

## Focused startup-race test

Command: `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/startup-race.test.ts`

```
/Users/yeongyu/.bash_profile: line 3: /usr/local/bin/gog.bash: No such file or directory

 RUN  v4.1.9 /Volumes/mengmotaStorage/local-workspaces/senpi-wt/senpi-mcp-plugin-w2/packages/coding-agent

······

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  01:52:10
   Duration  5.47s (transform 1.06s, setup 13ms, import 1.73s, tests 3.64s, environment 0ms)


Exit: 0
```

## Impacted MCP tests

Command: `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/catalog-cache.test.ts test/mcp/register-call.test.ts test/mcp/service-lifecycle.test.ts test/mcp/connection.test.ts test/mcp/ping-on-call.test.ts`

```
/Users/yeongyu/.bash_profile: line 3: /usr/local/bin/gog.bash: No such file or directory

 RUN  v4.1.9 /Volumes/mengmotaStorage/local-workspaces/senpi-wt/senpi-mcp-plugin-w2/packages/coding-agent

·································

 Test Files  5 passed (5)
      Tests  33 passed (33)
   Start at  01:52:16
   Duration  4.08s (transform 3.60s, setup 62ms, import 6.30s, tests 10.05s, environment 0ms)


Exit: 0
```

## Root npm check

Command: `npm run check`

```
/Users/yeongyu/.bash_profile: line 3: /usr/local/bin/gog.bash: No such file or directory

> check
> biome check --write --error-on-warnings . && npm run check:pinned-deps && npm run check:ts-imports && npm run check:shrinkwrap && npm run check:install-lock:coding-agent && tsgo --noEmit && node scripts/check-browser-smoke.mjs && node scripts/run-web-ui-check.mjs && npm run check:neo

Checked 1436 files in 985ms. No fixes applied.

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

Checked 67 files in 36ms. No fixes applied.

> pi-web-ui-example@0.75.3 check
> tsgo --noEmit


> check:neo
> node scripts/check-neo.mjs

check:neo: go build ./...
check:neo: go vet ./...
check:neo: go test ./...
ok  	github.com/code-yeongyu/senpi/packages/neo/cmd/senpi-neo	(cached)
?   	github.com/code-yeongyu/senpi/packages/neo/internal/app	[no test files]
ok  	github.com/code-yeongyu/senpi/packages/neo/internal/bridge	13.468s
?   	github.com/code-yeongyu/senpi/packages/neo/internal/bridge/attachqa	[no test files]
ok  	github.com/code-yeongyu/senpi/packages/neo/internal/store	(cached)
ok  	github.com/code-yeongyu/senpi/packages/neo/internal/store/clipboard	(cached)
?   	github.com/code-yeongyu/senpi/packages/neo/internal/store/qaharness	[no test files]
?   	github.com/code-yeongyu/senpi/packages/neo/internal/store/writeqa	[no test files]
ok  	github.com/code-yeongyu/senpi/packages/neo/internal/theme	2.778s
ok  	github.com/code-yeongyu/senpi/packages/neo/internal/ui	0.995s
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

Exit: 0
```

## Pure LOC proof

Command: `for f in packages/coding-agent/src/core/extensions/builtin/mcp/service.ts packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts packages/coding-agent/src/core/extensions/builtin/mcp/connection.ts packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts packages/coding-agent/test/mcp/startup-race.test.ts; do count=$(awk '!/^[[:space:]]*$/ && !/^[[:space:]]*(\/\/|#|--)/' "$f" | wc -l | tr -d ' '); printf '%s pure_loc=%s\n' "$f" "$count"; if [ "$count" -ge 250 ]; then exit 1; fi; done`

```
/Users/yeongyu/.bash_profile: line 3: /usr/local/bin/gog.bash: No such file or directory
packages/coding-agent/src/core/extensions/builtin/mcp/service.ts pure_loc=230
packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts pure_loc=80
packages/coding-agent/src/core/extensions/builtin/mcp/connection.ts pure_loc=249
packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts pure_loc=174
packages/coding-agent/test/mcp/startup-race.test.ts pure_loc=171

Exit: 0
```

## Forbidden TypeScript pattern audit

Command: `if rg -n '(as any|: any|<any>|@ts-(ignore|expect-error)|await import\(|\bimport\(["'"'"']|\b(import|export) =|\benum\b|\bnamespace\b|\bmodule\b|constructor\s*\([^)]*\b(private|public|protected)\s)' packages/coding-agent/src/core/extensions/builtin/mcp/service.ts packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts packages/coding-agent/src/core/extensions/builtin/mcp/connection.ts packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts packages/coding-agent/test/mcp/startup-race.test.ts; then exit 1; else printf 'PASS no forbidden TS patterns\n'; fi`

```
/Users/yeongyu/.bash_profile: line 3: /usr/local/bin/gog.bash: No such file or directory
PASS no forbidden TS patterns

Exit: 0
```

## Manual QA bundle integrity

Command: `for f in local-ignore/qa-evidence/20260706-mcp-w2-todo15/INDEX.md local-ignore/qa-evidence/20260706-mcp-w2-todo15/command-transcript.txt local-ignore/qa-evidence/20260706-mcp-w2-todo15/auth-isolation.txt local-ignore/qa-evidence/20260706-mcp-w2-todo15/cleanup.txt local-ignore/qa-evidence/20260706-mcp-w2-todo15/happy-rpc-transcript.json local-ignore/qa-evidence/20260706-mcp-w2-todo15/failure-rpc-transcript.json local-ignore/qa-evidence/20260706-mcp-w2-todo15/todo15-manual-qa-driver.mjs; do test -s "$f" || exit 1; printf 'OK %s bytes=%s\n' "$f" "$(wc -c < "$f" | tr -d ' ')"; done; rg -n 'happy: PASS|failure: PASS|realAuthAfterUnchanged=true|cleanup=complete' local-ignore/qa-evidence/20260706-mcp-w2-todo15/INDEX.md local-ignore/qa-evidence/20260706-mcp-w2-todo15/command-transcript.txt local-ignore/qa-evidence/20260706-mcp-w2-todo15/auth-isolation.txt local-ignore/qa-evidence/20260706-mcp-w2-todo15/cleanup.txt`

```
/Users/yeongyu/.bash_profile: line 3: /usr/local/bin/gog.bash: No such file or directory
OK local-ignore/qa-evidence/20260706-mcp-w2-todo15/INDEX.md bytes=1489
OK local-ignore/qa-evidence/20260706-mcp-w2-todo15/command-transcript.txt bytes=427
OK local-ignore/qa-evidence/20260706-mcp-w2-todo15/auth-isolation.txt bytes=313
OK local-ignore/qa-evidence/20260706-mcp-w2-todo15/cleanup.txt bytes=367
OK local-ignore/qa-evidence/20260706-mcp-w2-todo15/happy-rpc-transcript.json bytes=326570
OK local-ignore/qa-evidence/20260706-mcp-w2-todo15/failure-rpc-transcript.json bytes=232463
OK local-ignore/qa-evidence/20260706-mcp-w2-todo15/todo15-manual-qa-driver.mjs bytes=17656
local-ignore/qa-evidence/20260706-mcp-w2-todo15/cleanup.txt:1:cleanup=complete
local-ignore/qa-evidence/20260706-mcp-w2-todo15/INDEX.md:7:- happy: PASS. cached first request in 42ms; hot-swap exposed mcp_fx_tool_1,mcp_fx_tool_2. Artifact: /Volumes/mengmotaStorage/local-workspaces/senpi-wt/senpi-mcp-plugin-w2/local-ignore/qa-evidence/20260706-mcp-w2-todo15/happy-rpc-transcript.json
local-ignore/qa-evidence/20260706-mcp-w2-todo15/INDEX.md:8:- failure: PASS. cached tool stayed visible; ConnectError returned to model in 558ms and RPC stayed responsive. Artifact: /Volumes/mengmotaStorage/local-workspaces/senpi-wt/senpi-mcp-plugin-w2/local-ignore/qa-evidence/20260706-mcp-w2-todo15/failure-rpc-transcript.json
local-ignore/qa-evidence/20260706-mcp-w2-todo15/command-transcript.txt:4:happy: PASS - cached first request in 42ms; hot-swap exposed mcp_fx_tool_1,mcp_fx_tool_2
local-ignore/qa-evidence/20260706-mcp-w2-todo15/command-transcript.txt:5:failure: PASS - cached tool stayed visible; ConnectError returned to model in 558ms and RPC stayed responsive
local-ignore/qa-evidence/20260706-mcp-w2-todo15/auth-isolation.txt:3:realAuthAfterUnchanged=true

Exit: 0
```

## Tracked diff after verification

Command: `git diff --name-only`

```

Exit: 0
```

## Staged diff after verification

Command: `git diff --cached --name-only`

```

Exit: 0
```

## Judgment

PASS: Direct stop-hook verification reran the TODO15 test surfaces, root check, LOC proof, TS audit, manual QA artifact checks, and git state checks. service.ts is 230 pure LOC. Manual QA bundle still records happy/failure PASS, auth unchanged, and cleanup complete.
