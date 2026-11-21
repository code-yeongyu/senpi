import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseHookConfig } from "../../src/core/extensions/builtin/hooks/index.ts";
import { createHookTrustEntry, hookTrustId } from "../../src/core/extensions/builtin/hooks/trust.ts";
import type { HookSourceMetadata, HookTrustEntry } from "../../src/core/extensions/builtin/hooks/types.ts";

export type LifecycleHookEvent = "SessionStart" | "Stop";

/**
 * A trusted project shell hook for `event` that appends its event name to `hook-ran.txt` in its own cwd, then writes
 * `stdout` (a JSON value) as its output when given.
 */
export function writeLifecycleHook(cwd: string, event: LifecycleHookEvent, stdout?: unknown): void {
	const senpiDir = join(cwd, ".senpi");
	mkdirSync(senpiDir, { recursive: true });
	const script = join(senpiDir, `${event}.mjs`);
	const output = stdout === undefined ? "" : `process.stdout.write(${JSON.stringify(JSON.stringify(stdout))});`;
	writeFileSync(
		script,
		`import { appendFileSync } from 'node:fs'; process.stdin.resume(); process.stdin.on('end', () => { appendFileSync('hook-ran.txt', '${event}\\n'); ${output} });`,
	);
	const hookConfig = {
		hooks: { [event]: [{ hooks: [{ type: "command", command: `${process.execPath} ${script}` }] }] },
	};
	const sourcePath = join(senpiDir, "hooks.json");
	writeFileSync(sourcePath, JSON.stringify(hookConfig));
	const source = {
		discoveredAt: "pre-session",
		displayOrder: 0,
		scope: "project",
		sourcePath,
	} satisfies HookSourceMetadata;
	const hooks: Record<string, HookTrustEntry> = {};
	for (const handler of parseHookConfig(hookConfig, source).executableHandlers)
		hooks[hookTrustId(handler)] = createHookTrustEntry(handler, {
			platform: process.platform,
			updatedAt: "2026-11-15T00:00:00.000Z",
		});
	writeFileSync(join(senpiDir, "hooks-state.json"), JSON.stringify({ version: 1, hooks }));
}
