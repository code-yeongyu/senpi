import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import goalExtension from "../../src/core/extensions/builtin/goal/index.ts";
import { goalFilePath, readGoal } from "../../src/core/extensions/builtin/goal/store.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../src/core/extensions/types.ts";

type AnyTool = ToolDefinition<any, any, any>;
type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
type SentMessage = { message: { customType: string; content: string; display: boolean }; options: unknown };

interface GoalHarness {
	tools: Map<string, AnyTool>;
	commands: Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>;
	handlers: Map<string, Handler[]>;
	sent: SentMessage[];
}

function createGoalHarness(): GoalHarness {
	const tools = new Map<string, AnyTool>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const handlers = new Map<string, Handler[]>();
	const sent: SentMessage[] = [];
	const pi = {
		registerTool: (tool: AnyTool) => tools.set(tool.name, tool),
		registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
			commands.set(name, options),
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		sendMessage: (message: SentMessage["message"], options: unknown) => sent.push({ message, options }),
	} as unknown as ExtensionAPI;
	goalExtension(pi);
	return { tools, commands, handlers, sent };
}

const tempDirs: string[] = [];

async function makeCtx(threadId = "thread-test"): Promise<ExtensionContext> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-goal-ext-"));
	tempDirs.push(dir);
	return {
		hasUI: false,
		cwd: dir,
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: { notify: () => {}, select: async () => undefined, setStatus: () => {} },
		sessionManager: {
			getSessionFile: () => join(dir, "session.jsonl"),
			getSessionDir: () => dir,
			getSessionId: () => threadId,
		},
	} as unknown as ExtensionContext;
}

async function makeUiCtx(
	onStatus: (key: string, text: string | undefined) => void,
	threadId = "thread-ui",
): Promise<ExtensionContext> {
	const base = await makeCtx(threadId);
	return {
		...base,
		hasUI: true,
		ui: { notify: () => {}, select: async () => undefined, setStatus: onStatus },
	} as unknown as ExtensionContext;
}

function storeRefFor(ctx: ExtensionContext) {
	return {
		baseDir: join(ctx.sessionManager.getSessionDir(), "extensions", "goal"),
		threadId: ctx.sessionManager.getSessionId(),
	};
}

describe("goal extension contract (budget-free)", () => {
	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("registers the three codex-aligned tools and the /goal command", () => {
		const { tools, commands } = createGoalHarness();
		expect([...tools.keys()].sort()).toEqual(["create_goal", "get_goal", "update_goal"]);
		expect(commands.has("goal")).toBe(true);
	});

	it("exposes a budget-free create_goal schema (objective only)", () => {
		const { tools } = createGoalHarness();
		const schema = tools.get("create_goal")?.parameters as {
			type: string;
			properties: Record<string, unknown>;
			required: string[];
			additionalProperties: boolean;
		};
		expect(schema.type).toBe("object");
		expect(Object.keys(schema.properties)).toEqual(["objective"]);
		expect(schema.required).toEqual(["objective"]);
		expect(schema.additionalProperties).toBe(false);
		const serialized = JSON.stringify(tools.get("create_goal")).toLowerCase();
		expect(serialized).not.toContain("token_budget");
		expect(serialized).not.toContain("budget");
	});

	it("exposes blocked updates with limit-aware goal guidance and no budget language", () => {
		const { tools } = createGoalHarness();
		const create = tools.get("create_goal");
		const update = tools.get("update_goal");
		const serialized = JSON.stringify(update).toLowerCase();
		expect(create?.description).toMatch(/4,000.*file/i);
		expect(JSON.stringify(create?.parameters)).toMatch(/4,000.*file/i);
		expect(create?.description).toMatch(/complete.*archive.*unfinished/i);
		expect(serialized).toContain("complete");
		expect(serialized).toContain("blocked");
		expect(serialized).toContain("reason");
		expect(update?.description).toMatch(/3 consecutive goal turns/i);
		expect(update?.description).toMatch(/fresh blocked audit after resume/i);
		expect(update?.description).toMatch(/hard, slow, or uncertain/i);
		expect(serialized).not.toContain("budget");
		expect(JSON.stringify(tools.get("get_goal")).toLowerCase()).not.toContain("budget");
	});

	it("creates, reads, and completes a goal through the tools and file store", async () => {
		const { tools } = createGoalHarness();
		const ctx = await makeCtx();
		const ref = storeRefFor(ctx);

		const created = await tools
			.get("create_goal")
			?.execute("c1", { objective: "Ship goal builtin" }, undefined, undefined, ctx);
		expect(created).toBeDefined();
		const persisted = await readGoal(ref);
		expect(persisted?.objective).toBe("Ship goal builtin");
		expect(persisted?.status).toBe("active");
		expect(persisted).not.toHaveProperty("tokenBudget");
		expect(goalFilePath(ref)).toContain(join("extensions", "goal"));

		const got = await tools.get("get_goal")?.execute("g1", {}, undefined, undefined, ctx);
		expect(JSON.parse(textOf(got))).toMatchObject({ goal: { objective: "Ship goal builtin", status: "active" } });
		expect(textOf(got).toLowerCase()).not.toContain("budget");

		await tools.get("update_goal")?.execute("u1", { status: "complete" }, undefined, undefined, ctx);
		expect((await readGoal(ref))?.status).toBe("complete");
	});

	it("replaces a completed goal through create_goal, archives it, and rejects unfinished goals", async () => {
		const { tools } = createGoalHarness();
		const ctx = await makeCtx("thread/complete-create");
		const ref = storeRefFor(ctx);
		await tools.get("create_goal")?.execute("c1", { objective: "First" }, undefined, undefined, ctx);
		await tools.get("update_goal")?.execute("u1", { status: "complete" }, undefined, undefined, ctx);

		const replacement = await tools
			.get("create_goal")
			?.execute("c2", { objective: "Second" }, undefined, undefined, ctx);
		expect(JSON.parse(textOf(replacement))).toMatchObject({ goal: { objective: "Second", status: "active" } });
		const history = await readFile(join(ref.baseDir, `${encodeURIComponent(ref.threadId)}.history.jsonl`), "utf8");
		expect(history.trim().split("\n")).toHaveLength(1);
		expect(JSON.parse(history)).toMatchObject({ objective: "First", status: "complete" });

		const unfinished = await makeCtx("thread-active-create");
		await tools.get("create_goal")?.execute("c3", { objective: "Active" }, undefined, undefined, unfinished);
		await expect(
			tools.get("create_goal")?.execute("c4", { objective: "Replacement" }, undefined, undefined, unfinished),
		).rejects.toThrow("unfinished goal");
	});

	it("spills an oversized objective with a marker-aware stored objective and notice", async () => {
		const { tools } = createGoalHarness();
		const ctx = await makeCtx("thread/oversized objective");
		const ref = storeRefFor(ctx);
		const objective = "x".repeat(4_200);

		const result = await tools.get("create_goal")?.execute("c1", { objective }, undefined, undefined, ctx);
		const goal = await readGoal(ref);
		expect(textOf(result)).toContain("Objective was truncated; full objective saved to");
		expect([...String(goal?.objective)].length).toBeLessThanOrEqual(4_000);
		expect(goal?.objective).toContain("[truncated; full objective:");
		expect(await readFile(join(ref.baseDir, `${encodeURIComponent(ref.threadId)}.objective-full.txt`), "utf8")).toBe(
			objective,
		);
	});

	it("requires a reason to block and suppresses continuation while blocked", async () => {
		const { tools, handlers, sent } = createGoalHarness();
		const ctx = await makeCtx();
		await tools.get("create_goal")?.execute("c1", { objective: "Wait for a decision" }, undefined, undefined, ctx);
		await expect(
			tools.get("update_goal")?.execute("u1", { status: "blocked" }, undefined, undefined, ctx),
		).rejects.toThrow("reason is required");
		await expect(
			tools
				.get("update_goal")
				?.execute("u2", { status: "complete", reason: "not allowed" }, undefined, undefined, ctx),
		).rejects.toThrow("reason must not be provided");
		await tools
			.get("update_goal")
			?.execute("u3", { status: "blocked", reason: "Waiting on a user decision" }, undefined, undefined, ctx);
		await runHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [assistantMessageWithStopReason("stop")] },
			ctx,
		);

		expect(await readGoal(storeRefFor(ctx))).toMatchObject({
			status: "blocked",
			blockedReason: "Waiting on a user decision",
			blockedAt: expect.any(Number),
		});
		expect(sent).toHaveLength(0);
	});

	it("queues a hidden continuation prompt after agent_end while a goal is active", async () => {
		const { tools, handlers, sent } = createGoalHarness();
		const ctx = await makeCtx();
		await tools.get("create_goal")?.execute("c1", { objective: "Keep going" }, undefined, undefined, ctx);

		await runHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [assistantMessageWithStopReason("stop")] },
			ctx,
		);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.customType).toBe("goal-continuation");
		expect(sent[0]?.message.display).toBe(false);
		expect(sent[0]?.message.content.toLowerCase()).not.toContain("token budget");
	});

	it("does not queue a hidden continuation prompt after an aborted agent_end", async () => {
		const { tools, handlers, sent } = createGoalHarness();
		const ctx = await makeCtx();
		await tools.get("create_goal")?.execute("c1", { objective: "Stop when aborted" }, undefined, undefined, ctx);

		await runHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [assistantMessageWithStopReason("aborted")] },
			ctx,
		);

		expect(sent).toHaveLength(0);
	});

	it("does not queue a hidden continuation prompt after an error agent_end", async () => {
		const { tools, handlers, sent } = createGoalHarness();
		const ctx = await makeCtx();
		await tools
			.get("create_goal")
			?.execute("c1", { objective: "Stop when provider errors" }, undefined, undefined, ctx);

		await runHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [assistantMessageWithStopReason("error")] },
			ctx,
		);

		expect(sent).toHaveLength(0);
	});

	it("renders a live elapsed footer segment while a goal is actively pursued", async () => {
		const statuses: Array<string | undefined> = [];
		const { tools, commands } = createGoalHarness();
		const ctx = await makeUiCtx((key, text) => {
			if (key === "goal") statuses.push(text);
		});

		await tools.get("create_goal")?.execute("c1", { objective: "Ship it live" }, undefined, undefined, ctx);
		// The ticker syncs immediately on the active goal, so the footer already
		// carries the parenthesized live elapsed time rather than a frozen label.
		expect(statuses.at(-1)).toBe("Pursuing goal (0s)");

		// Clearing stops the ticker interval and wipes the footer segment.
		await commands.get("goal")?.handler("clear", ctx);
		expect(statuses.at(-1)).toBeUndefined();
	});
});

function textOf(result: { content?: Array<{ type: string; text?: string }> } | undefined): string {
	return result?.content?.find((part) => part.type === "text")?.text ?? "";
}

async function runHandlers(
	handlers: Map<string, Handler[]>,
	event: string,
	payload: unknown,
	ctx: ExtensionContext,
): Promise<void> {
	for (const handler of handlers.get(event) ?? []) {
		await handler(payload, ctx);
	}
}

function assistantMessageWithStopReason(stopReason: "aborted" | "error" | "stop"): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage:
			stopReason === "aborted"
				? "Operation aborted"
				: stopReason === "error"
					? "429 usage limit reached"
					: undefined,
		timestamp: Date.now(),
	};
}
