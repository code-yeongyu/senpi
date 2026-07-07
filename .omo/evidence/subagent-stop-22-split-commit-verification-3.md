# Stop-hook verification 3: fresh command run

Worktree: `/Volumes/mengmotaStorage/local-workspaces/senpi-wt/senpi-mcp-plugin-w2`
Recorded UTC: `2026-07-06T19:01:04Z`

This receipt was produced after the third stop-hook challenge and includes freshly rerun focused tests.

## Git identity and status

### `git status --short --branch`

```text
## code-yeongyu/senpi-mcp-plugin-w2
?? .omo/evidence/subagent-stop-22-split-commit-verification-2.md
?? .omo/evidence/subagent-stop-22-split-commit-verification-3.md
?? .omo/evidence/subagent-stop-22-split-commit-verification.md
?? .omo/evidence/task-16-stop-hook-verification-2.md
?? .omo/evidence/task-16-stop-hook-verification-3.md
?? .omo/evidence/task-16-stop-hook-verification.md
?? .omo/evidence/todo-14-stop-hook-verification-2.md
?? .omo/evidence/todo-14-stop-hook-verification.md
```

### `git log -2 --oneline`

```text
9e1df72ba feat(coding-agent): mcp large-output guard with spill-to-file
c804d6140 feat(coding-agent): stdio failure diagnosis and http session-expiry recovery
```

### `git rev-parse c804d6140 9e1df72ba`

```text
c804d61403bcc0f4429f7b8d9b37d74e1d4bf9a1
9e1df72ba9a12c19cae41103df4451e14b7152ab
```

## Commit path/hunk verification

### TODO19 `git show --name-status --format=oneline --no-renames c804d6140`

```text
c804d61403bcc0f4429f7b8d9b37d74e1d4bf9a1 feat(coding-agent): stdio failure diagnosis and http session-expiry recovery
A	.omo/evidence/task-19-senpi-mcp-plugin-check.log
A	.omo/evidence/task-19-senpi-mcp-plugin-green-diagnose.log
A	.omo/evidence/task-19-senpi-mcp-plugin-impacted.log
A	.omo/evidence/task-19-senpi-mcp-plugin-red.log
A	.omo/evidence/todo-19-code-quality-slop-review.md
M	packages/coding-agent/src/core/extensions/builtin/mcp/connection.ts
A	packages/coding-agent/src/core/extensions/builtin/mcp/diagnose.ts
M	packages/coding-agent/src/core/extensions/builtin/mcp/errors.ts
M	packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts
M	packages/coding-agent/src/core/extensions/builtin/mcp/health.ts
M	packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts
A	packages/coding-agent/test/mcp/diagnose.test.ts
M	packages/coding-agent/test/mcp/fixtures/http-server.ts
M	packages/coding-agent/test/mcp/fixtures/options.ts
M	packages/coding-agent/test/mcp/fixtures/stdio-server.ts
```

### TODO20 `git show --name-status --format=oneline --no-renames 9e1df72ba`

```text
9e1df72ba9a12c19cae41103df4451e14b7152ab feat(coding-agent): mcp large-output guard with spill-to-file
A	.omo/evidence/task-19-task-20-loc-audit.log
A	.omo/evidence/task-19-task-20-senpi-mcp-plugin-check.log
A	.omo/evidence/task-20-senpi-mcp-plugin-check.log
A	.omo/evidence/task-20-senpi-mcp-plugin-green-output-guard.log
A	.omo/evidence/task-20-senpi-mcp-plugin-impacted.log
A	.omo/evidence/task-20-senpi-mcp-plugin-red.log
A	.omo/evidence/todo-20-code-quality-slop-review.md
M	packages/coding-agent/src/core/extensions/builtin/mcp/catalog.ts
M	packages/coding-agent/src/core/extensions/builtin/mcp/config-schema.ts
M	packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts
M	packages/coding-agent/src/core/extensions/builtin/mcp/expose/session.ts
A	packages/coding-agent/src/core/extensions/builtin/mcp/guard/output-guard.ts
M	packages/coding-agent/src/core/extensions/builtin/mcp/service.ts
M	packages/coding-agent/test/mcp/fixtures/options.ts
M	packages/coding-agent/test/mcp/fixtures/sdk-server.ts
A	packages/coding-agent/test/mcp/output-guard.test.ts
```

### TODO19 full diff vs recorded patch artifact

```text
PASS: TODO19 recorded patch equals git diff c804d6140^..c804d6140
```

### TODO20 full diff vs recorded patch artifact

```text
PASS: TODO20 recorded patch equals git diff 9e1df72ba^..9e1df72ba
```

### TODO19 excludes TODO20 output guard strings

```text

```

Assertion: PASS

### TODO20 includes output guard strings

```text
232:+    143|  const match = text.match(/Full output saved to: (.+)/);
245:+    143|  const match = text.match(/Full output saved to: (.+)/);
259:+    143|  const match = text.match(/Full output saved to: (.+)/);
879:+	outputGuard?: McpSettings["outputGuard"];
886:+	options: Pick<McpToolCatalogEntry, "agentDir" | "outputGuard"> = {},
896:+		outputGuard: options.outputGuard,
904:+	options: Pick<McpToolCatalogEntry, "agentDir" | "outputGuard"> = {},
912:+		outputGuard: options.outputGuard,
926:+	outputGuard: { maxBytes: 50 * 1024, maxLines: 2000 },
938:+import { applyMcpOutputGuard } from "../guard/output-guard.ts";
947:+			const guarded = await applyMcpOutputGuard(mapped.content, {
949:+				outputGuard: entry.outputGuard,
975:+							outputGuard: config.settings.outputGuard,
984:+						{ agentDir: entry.agentDir, outputGuard: config.settings.outputGuard },
1003:+	readonly outputGuard?: McpSettings["outputGuard"];
1020:+export async function applyMcpOutputGuard(
1024:+	const limits = outputGuardLimits(options.outputGuard);
1036:+function outputGuardLimits(outputGuard: McpSettings["outputGuard"]): { maxBytes: number; maxLines: number } {
1038:+		maxBytes: positiveInteger(outputGuard?.maxBytes) ?? DEFAULT_MAX_BYTES,
1039:+		maxLines: positiveInteger(outputGuard?.maxLines) ?? DEFAULT_MAX_LINES,
1126:+		`MCP tool output exceeded outputGuard; ${payload.summary}.`,
1127:+		`Full output saved to: ${path}`,
1232:+	binaryOutputTool: boolean;
1240:+		binaryOutputTool: argv.includes("--binary-output-tool"),
1260:+	if (options.binaryOutputTool) {
1274:+	if (name === "binary_output_tool" && options.binaryOutputTool) {
1293:+import { applyMcpOutputGuard } from "../../src/core/extensions/builtin/mcp/guard/output-guard.ts";
1376:+		const result = await applyMcpOutputGuard(
1434:+					settings: { outputGuard: { maxBytes: 1, maxLines: 1 } },
1474:+	const match = text.match(/Full output saved to: (.+)/);
```

Assertion: PASS

## Fresh focused test reruns

### TODO19 focused rerun

Command: `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/diagnose.test.ts`

```text

 RUN  v4.1.9 /Volumes/mengmotaStorage/local-workspaces/senpi-wt/senpi-mcp-plugin-w2/packages/coding-agent

····

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  04:01:05
   Duration  6.71s (transform 48ms, setup 11ms, import 95ms, tests 6.51s, environment 0ms)

```

TODO19 focused rerun assertion: PASS

### TODO20 focused rerun

Command: `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/output-guard.test.ts`

```text

 RUN  v4.1.9 /Volumes/mengmotaStorage/local-workspaces/senpi-wt/senpi-mcp-plugin-w2/packages/coding-agent

·······

 Test Files  1 passed (1)
      Tests  7 passed (7)
   Start at  04:01:12
   Duration  3.41s (transform 1.05s, setup 10ms, import 1.70s, tests 1.62s, environment 0ms)

```

TODO20 focused rerun assertion: PASS

## Existing broader evidence checks

### Impacted/root/manual evidence grep

```text
6: Test Files  5 passed (5)
7:      Tests  39 passed (39)
6: Test Files  4 passed (4)
7:      Tests  26 passed (26)
71:check:neo: packages/neo build+vet+test passed
26:- PASS QA auth isolation
35:- guardRealAuth() verified the real auth.json hash was unchanged.
37:Overall: PASS
```

Broader evidence assertion: PASS

### LOC audit command

```text
packages/coding-agent/src/core/extensions/builtin/mcp/catalog.ts pure_loc=60
packages/coding-agent/src/core/extensions/builtin/mcp/config-schema.ts pure_loc=131
packages/coding-agent/src/core/extensions/builtin/mcp/connection.ts pure_loc=250
packages/coding-agent/src/core/extensions/builtin/mcp/diagnose.ts pure_loc=147
packages/coding-agent/src/core/extensions/builtin/mcp/errors.ts pure_loc=147
packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts pure_loc=185
packages/coding-agent/src/core/extensions/builtin/mcp/expose/session.ts pure_loc=49
packages/coding-agent/src/core/extensions/builtin/mcp/guard/output-guard.ts pure_loc=181
packages/coding-agent/src/core/extensions/builtin/mcp/health.ts pure_loc=85
packages/coding-agent/src/core/extensions/builtin/mcp/service.ts pure_loc=239
packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts pure_loc=80
packages/coding-agent/test/mcp/diagnose.test.ts pure_loc=171
packages/coding-agent/test/mcp/fixtures/http-server.ts pure_loc=127
packages/coding-agent/test/mcp/fixtures/options.ts pure_loc=136
packages/coding-agent/test/mcp/fixtures/sdk-server.ts pure_loc=242
packages/coding-agent/test/mcp/fixtures/stdio-server.ts pure_loc=52
packages/coding-agent/test/mcp/output-guard.test.ts pure_loc=174
```

LOC assertion: PASS

## Final status after fresh verification

```text
## code-yeongyu/senpi-mcp-plugin-w2
?? .omo/evidence/subagent-stop-22-split-commit-verification-2.md
?? .omo/evidence/subagent-stop-22-split-commit-verification-3.md
?? .omo/evidence/subagent-stop-22-split-commit-verification.md
?? .omo/evidence/task-16-stop-hook-verification-2.md
?? .omo/evidence/task-16-stop-hook-verification-3.md
?? .omo/evidence/task-16-stop-hook-verification.md
?? .omo/evidence/todo-14-stop-hook-verification-2.md
?? .omo/evidence/todo-14-stop-hook-verification.md
```

## Overall judgment

PASS: Fresh verification commands and focused test reruns passed.
