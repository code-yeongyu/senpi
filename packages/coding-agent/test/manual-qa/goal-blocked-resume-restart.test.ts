/**
 * Real-surface QA driver (manual-qa; not part of the default suite).
 *
 * Drives the REAL builtin goal extension across a simulated process restart to
 * prove that a `blocked` goal produces the restart resume prompt, that accepting
 * reactivates it and queues a continuation, and that declining leaves it blocked.
 *
 * Run: npx vitest run test/manual-qa/goal-blocked-resume-restart.test.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import goalExtension from "../../src/core/extensions/builtin/goal/index.ts";
import { readGoal } from "../../src/core/extensions/builtin/goal/store.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../src/core/extensions/types.ts";
import { GOAL_CONTINUATION_MESSAGE_TYPE } from "../../src/core/messages.ts";

type AnyTool = ToolDefinition<any, any, any>;
type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

const THREAD = "qa-thread-blocked";
const transcript: string[] = [];
const say = (line: string): void => {
	transcript.push(line);
	console.log(line);
};

function makeSession(dir: string, onSelect: (options: string[]) => string | undefined) {
	const tools = new Map<string, AnyTool>();
	const handlers = new Map<string, Handler[]>();
	const sent: Array<{ customType: string }> = [];
	const prompts: Array<{ prompt: string; options: string[] }> = [];
	const pi = {
		registerTool: (tool: AnyTool) => tools.set(tool.name, tool),
		registerCommand: () => {},
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		sendMessage: (message: { customType: string }) => sent.push(message),
		registerEntryRenderer: () => {},
		appendEntry: () => {},
	} as unknown as ExtensionAPI;
	goalExtension(pi);
	const ctx = {
		hasUI: true,
		cwd: dir,
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: {
			notify: () => {},
			setStatus: () => {},
			select: async (prompt: string, options: string[]) => {
				prompts.push({ prompt, options });
				return onSelect(options);
			},
		},
		sessionManager: {
			getSessionFile: () => join(dir, "session.jsonl"),
			getSessionDir: () => dir,
			getSessionId: () => THREAD,
			getBranch: () =>
				[0, 1].map(() => ({
					type: "custom_message",
					customType: GOAL_CONTINUATION_MESSAGE_TYPE,
					content: "Continue working toward the active thread goal.",
					display: false,
					timestamp: new Date().toISOString(),
				})),
		},
	} as unknown as ExtensionContext;
	const fire = async (event: string, payload: unknown): Promise<void> => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	};
	return { tools, ctx, sent, prompts, fire };
}

it("prompts to resume a blocked goal after a process restart", async () => {
	const dir = await mkdtemp(join(tmpdir(), "senpi-qa-goal-resume-"));
	const storeRef = { baseDir: join(dir, "extensions", "goal"), threadId: THREAD };

	// Session A: the goal gets blocked, then the process goes away.
	const a = makeSession(dir, () => undefined);
	await a.tools
		.get("create_goal")
		?.execute("c1", { objective: "Finish the release checklist" }, undefined, undefined, a.ctx);
	await a.tools
		.get("update_goal")
		?.execute("u1", { status: "blocked", reason: "user interrupted the turn" }, undefined, undefined, a.ctx);
	await a.fire("session_shutdown", { type: "session_shutdown" });
	const afterA = await readGoal(storeRef);
	say(`[session A] persisted status after shutdown: ${afterA?.status} (reason: ${afterA?.blockedReason})`);
	expect(afterA?.status).toBe("blocked");

	// Session B: fresh process over the same store, resumed -> must prompt.
	const b = makeSession(dir, (options) => options[0]);
	await b.fire("session_start", { type: "session_start", reason: "resume" });
	say(`[session B] resume prompts shown: ${b.prompts.length}`);
	for (const entry of b.prompts) {
		say(`[session B] prompt body:    ${JSON.stringify(entry.prompt)}`);
		say(`[session B] prompt options: ${JSON.stringify(entry.options)}`);
	}
	const afterB = await readGoal(storeRef);
	say(`[session B] status after accepting "Resume goal": ${afterB?.status}`);
	say(`[session B] continuation queued: ${JSON.stringify(b.sent.map((message) => message.customType))}`);

	expect(b.prompts).toHaveLength(1);
	expect(b.prompts[0]?.prompt).toContain("Resume blocked goal?");
	expect(b.prompts[0]?.prompt).toContain("Finish the release checklist");
	expect(b.prompts[0]?.options).toEqual(["Resume goal", "Leave stopped"]);
	expect(afterB?.status).toBe("active");
	expect(b.sent.map((message) => message.customType)).toEqual(["goal-continuation"]);

	// Session C: blocked again, resumed, declined -> stays blocked.
	await b.tools
		.get("update_goal")
		?.execute("u2", { status: "blocked", reason: "user interrupted the turn" }, undefined, undefined, b.ctx);
	const c = makeSession(dir, (options) => options[1]);
	await c.fire("session_start", { type: "session_start", reason: "resume" });
	const afterC = await readGoal(storeRef);
	say(`[session C] declined -> status stays: ${afterC?.status}; continuations queued: ${c.sent.length}`);
	expect(afterC?.status).toBe("blocked");
	expect(c.sent).toHaveLength(0);

	await rm(dir, { recursive: true, force: true });
	say(`cleanup: rm -rf ${dir}`);
});
