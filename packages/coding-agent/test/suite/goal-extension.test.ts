import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

	it("restricts update_goal to complete and drops budget language", () => {
		const { tools } = createGoalHarness();
		const update = tools.get("update_goal");
		const serialized = JSON.stringify(update).toLowerCase();
		expect(serialized).toContain("complete");
		expect(serialized).not.toContain("blocked");
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

	it("refuses a second create_goal while a goal exists", async () => {
		const { tools } = createGoalHarness();
		const ctx = await makeCtx();
		await tools.get("create_goal")?.execute("c1", { objective: "First" }, undefined, undefined, ctx);
		await expect(
			tools.get("create_goal")?.execute("c2", { objective: "Second" }, undefined, undefined, ctx),
		).rejects.toThrow("already has a goal");
	});

	it("queues a hidden continuation prompt after agent_end while a goal is active", async () => {
		const { tools, handlers, sent } = createGoalHarness();
		const ctx = await makeCtx();
		await tools.get("create_goal")?.execute("c1", { objective: "Keep going" }, undefined, undefined, ctx);

		await runHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runHandlers(handlers, "agent_end", { type: "agent_end", messages: [] }, ctx);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.customType).toBe("goal-continuation");
		expect(sent[0]?.message.display).toBe(false);
		expect(sent[0]?.message.content.toLowerCase()).not.toContain("token budget");
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
