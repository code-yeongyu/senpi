// senpi#5898: a hosted loop forwards its lifecycle events to the hand, so the user's SessionStart shell hooks run on
// the user's machine as they do in a local session (brain/hand split, K5; hooks builtin C8).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseHookConfig } from "../../src/core/extensions/builtin/hooks/index.ts";
import { createHookTrustEntry, hookTrustId } from "../../src/core/extensions/builtin/hooks/trust.ts";
import type { HookSourceMetadata, HookTrustEntry } from "../../src/core/extensions/builtin/hooks/types.ts";
import { createLooplessHand } from "../../src/modes/rpc/remote-executor-scope.ts";
import { cleanupHands, handConfiguration, handDirs } from "./remote-hand-fixture.ts";

afterEach(cleanupHands);

type LifecycleEvent = "SessionStart";

function writeLifecycleHook(cwd: string, event: LifecycleEvent, context?: string): void {
	const senpiDir = join(cwd, ".senpi");
	mkdirSync(senpiDir, { recursive: true });
	const script = join(senpiDir, `${event}.mjs`);
	const output =
		context === undefined
			? ""
			: `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: '${event}', additionalContext: '${context}' } }));`;
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

async function userMachine(event: LifecycleEvent, context?: string) {
	const dirs = await handDirs("k5-lifecycle");
	writeLifecycleHook(dirs.cwd, event, context);
	const machine = createLooplessHand(handConfiguration(dirs), { twoSidedHome: "hand" });
	const sessionId = `loop-${crypto.randomUUID()}`;
	const base = { sessionId, idle: false, scope: { id: `session-${sessionId}`, root: dirs.cwd } };
	const marker = join(dirs.cwd, "hook-ran.txt");
	return {
		machine,
		base,
		marks: () => (existsSync(marker) ? readFileSync(marker, "utf-8") : ""),
	};
}

interface LifecycleReply {
	readonly sent?: { message: { content: unknown } }[];
	readonly errors?: unknown[];
}

describe("a hosted loop's lifecycle hooks run on the user's machine (senpi#5898)", () => {
	it("session_start runs the user's SessionStart hook there and returns its context for the loop to send", async () => {
		const user = await userMachine("SessionStart", "context from the user machine");

		const reply = (await user.machine.loopHooks("session_start", {
			...user.base,
			reason: "startup",
		})) as LifecycleReply;

		expect(user.marks()).toBe("SessionStart\n");
		expect(reply.errors).toBeUndefined();
		expect(JSON.stringify(reply.sent?.map((sent) => sent.message.content))).toContain(
			"context from the user machine",
		);
	});
});
