import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import goalExtension from "../../src/core/extensions/builtin/goal/index.ts";
import { readGoal } from "../../src/core/extensions/builtin/goal/store.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../src/core/extensions/types.ts";

type AnyTool = ToolDefinition<any, any, any>;
type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

interface GoalHarness {
	tools: Map<string, AnyTool>;
	handlers: Map<string, Handler[]>;
}

function createGoalHarness(): GoalHarness {
	const tools = new Map<string, AnyTool>();
	const handlers = new Map<string, Handler[]>();
	const pi = {
		registerTool: (tool: AnyTool) => tools.set(tool.name, tool),
		registerCommand: () => {},
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		sendMessage: () => {},
	} as unknown as ExtensionAPI;
	goalExtension(pi);
	return { tools, handlers };
}

const tempDirs: string[] = [];

async function makeCtx(threadId = "thread-usage"): Promise<ExtensionContext> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-goal-usage-"));
	tempDirs.push(dir);
	return {
		hasUI: false,
		cwd: dir,
		isIdle: () => true,
		hasPendingMessages: () => false,
		signal: undefined,
		ui: { notify: () => {}, select: async () => undefined, setStatus: () => {} },
		sessionManager: {
			getSessionFile: () => join(dir, "session.jsonl"),
			getSessionDir: () => dir,
			getSessionId: () => threadId,
		},
	} as unknown as ExtensionContext;
}

function storeRefFor(ctx: ExtensionContext) {
	return {
		baseDir: join(ctx.sessionManager.getSessionDir(), "extensions", "goal"),
		threadId: ctx.sessionManager.getSessionId(),
	};
}

function assistantMessage(input: number, output: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
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

async function streamAssistantMessage(
	harness: GoalHarness,
	ctx: ExtensionContext,
	message: AgentMessage,
): Promise<void> {
	await runHandlers(harness.handlers, "message_end", { type: "message_end", message }, ctx);
}

function textOf(result: { content?: Array<{ type: string; text?: string }> } | undefined): string {
	return result?.content?.find((part) => part.type === "text")?.text ?? "";
}

function tokensUsedOf(result: unknown): number {
	const parsed = JSON.parse(textOf(result as { content?: Array<{ type: string; text?: string }> }));
	return parsed.goal.tokensUsed;
}

describe("goal mid-turn token usage accounting", () => {
	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("update_goal completed mid-turn reports tokens accumulated from streamed assistant messages", async () => {
		const harness = createGoalHarness();
		const ctx = await makeCtx();
		await harness.tools.get("create_goal")?.execute("c1", { objective: "Ship it" }, undefined, undefined, ctx);
		await runHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
		await streamAssistantMessage(harness, ctx, assistantMessage(100, 50));

		const completed = await harness.tools
			.get("update_goal")
			?.execute("u1", { status: "complete" }, undefined, undefined, ctx);

		expect(tokensUsedOf(completed)).toBe(150);
	});

	it("get_goal mid-turn reports tokens accumulated from streamed assistant messages", async () => {
		const harness = createGoalHarness();
		const ctx = await makeCtx();
		await harness.tools.get("create_goal")?.execute("c1", { objective: "Ship it" }, undefined, undefined, ctx);
		await runHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
		await streamAssistantMessage(harness, ctx, assistantMessage(100, 50));

		const snapshot = await harness.tools.get("get_goal")?.execute("g1", {}, undefined, undefined, ctx);

		expect(tokensUsedOf(snapshot)).toBe(150);
	});

	it("agent_end accounts only the remaining usage after a mid-turn completion", async () => {
		const harness = createGoalHarness();
		const ctx = await makeCtx();
		const first = assistantMessage(100, 50);
		const second = assistantMessage(10, 5);
		await harness.tools.get("create_goal")?.execute("c1", { objective: "Ship it" }, undefined, undefined, ctx);
		await runHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
		await streamAssistantMessage(harness, ctx, first);
		await harness.tools.get("update_goal")?.execute("u1", { status: "complete" }, undefined, undefined, ctx);
		await streamAssistantMessage(harness, ctx, second);

		await runHandlers(harness.handlers, "agent_end", { type: "agent_end", messages: [first, second] }, ctx);

		expect((await readGoal(storeRefFor(ctx)))?.tokensUsed).toBe(165);
	});

	it("session_shutdown accounts streamed usage not yet checkpointed", async () => {
		const harness = createGoalHarness();
		const ctx = await makeCtx();
		await harness.tools.get("create_goal")?.execute("c1", { objective: "Ship it" }, undefined, undefined, ctx);
		await runHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
		await streamAssistantMessage(harness, ctx, assistantMessage(100, 50));

		await runHandlers(harness.handlers, "session_shutdown", { type: "session_shutdown" }, ctx);

		expect((await readGoal(storeRefFor(ctx)))?.tokensUsed).toBe(150);
	});

	it("a goal created mid-turn is not charged usage streamed before it existed", async () => {
		const harness = createGoalHarness();
		const ctx = await makeCtx();
		const before = assistantMessage(1000, 500);
		const after = assistantMessage(10, 5);
		await runHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
		await streamAssistantMessage(harness, ctx, before);
		await harness.tools.get("create_goal")?.execute("c1", { objective: "Late goal" }, undefined, undefined, ctx);
		await streamAssistantMessage(harness, ctx, after);

		await runHandlers(harness.handlers, "agent_end", { type: "agent_end", messages: [before, after] }, ctx);

		expect((await readGoal(storeRefFor(ctx)))?.tokensUsed).toBe(15);
	});
});
