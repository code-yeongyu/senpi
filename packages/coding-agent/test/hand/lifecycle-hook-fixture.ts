import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/pi-ai";
import { parseHookConfig } from "../../src/core/extensions/builtin/hooks/index.ts";
import { createHookTrustEntry, hookTrustId } from "../../src/core/extensions/builtin/hooks/trust.ts";
import type { HookSourceMetadata, HookTrustEntry } from "../../src/core/extensions/builtin/hooks/types.ts";
import type { InlineExtension } from "../../src/core/extensions/types.ts";
import { createLooplessHand } from "../../src/modes/rpc/remote-executor-scope.ts";
import { handConfiguration, handDirs } from "./remote-hand-fixture.ts";

export type LifecycleHookEvent = "SessionStart" | "Stop" | "PreCompact" | "PostCompact";

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

export interface UserMachineOptions {
	/** A trusted shell hook for this event, writing `stdout` as its output. */
	readonly hook?: LifecycleHookEvent;
	readonly stdout?: unknown;
	readonly extension?: string;
	/** In-process extensions that replace the hand's default ones. */
	readonly extensionFactories?: InlineExtension[];
	readonly settings?: Record<string, unknown>;
}

/** The user's machine: a hand that is its extensions' home, and the loop session a call names. */
export async function userMachine(options: UserMachineOptions) {
	const dirs = await handDirs("k5-lifecycle");
	if (options.hook !== undefined) writeLifecycleHook(dirs.cwd, options.hook, options.stdout);
	if (options.settings !== undefined) {
		mkdirSync(dirs.agentDir, { recursive: true });
		writeFileSync(join(dirs.agentDir, "settings.json"), JSON.stringify(options.settings));
	}
	const extension = join(dirs.scratch, "user-lifecycle-ext.ts");
	if (options.extension !== undefined) writeFileSync(extension, options.extension);
	const args = options.extension === undefined ? [] : ["-e", extension];
	const { extensionFactories } = options;
	const machine = createLooplessHand(handConfiguration(dirs, args), {
		twoSidedHome: "hand",
		...(extensionFactories === undefined ? {} : { extensionFactories }),
	});
	const sessionId = `loop-${crypto.randomUUID()}`;
	const base = { sessionId, idle: false, scope: { id: `session-${sessionId}`, root: dirs.cwd } };
	const marker = join(dirs.cwd, "hook-ran.txt");
	return {
		machine,
		base,
		marks: () => (existsSync(marker) ? readFileSync(marker, "utf-8") : ""),
	};
}

export interface LifecycleReply {
	readonly cancel?: boolean;
	readonly compaction?: { summary: string; firstKeptEntryId: string; tokensBefore: number };
	readonly sent?: { message: { content: unknown; details?: { event?: string; compactionRequestId?: string } } }[];
	readonly entries?: { customType: string; data?: unknown }[];
	readonly userMessages?: { content: unknown; options?: unknown }[];
	readonly notices?: unknown[];
	readonly errors?: { extensionPath: string; event: string; error: string }[];
}

export const toJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
