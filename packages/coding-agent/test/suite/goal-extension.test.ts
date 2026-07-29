import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import goalExtension from "../../src/core/extensions/builtin/goal/index.ts";
import { MonitorAwareGoalContinuation } from "../../src/core/extensions/builtin/goal/monitor-continuation.ts";
import * as persistence from "../../src/core/extensions/builtin/goal/persistence.ts";
import { goalFilePath, readGoal } from "../../src/core/extensions/builtin/goal/store.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../src/core/extensions/types.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";

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
		registerEntryRenderer: () => {},
		appendEntry: () => {},
	} as unknown as ExtensionAPI;
	goalExtension(pi);
	return { tools, commands, handlers, sent };
}

const tempDirs: string[] = [];

async function makeCtx(threadId = "thread-test", branchEntries: SessionEntry[] = []): Promise<ExtensionContext> {
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
			getBranch: () => branchEntries,
		},
	} as unknown as ExtensionContext;
}

function todoStateEntry(
	phases: Array<{ name: string; tasks: Array<{ content: string; status: string }> }>,
): SessionEntry {
	return {
		type: "custom",
		customType: "senpi.todo-state",
		data: { schema: "v2", phases },
	} as unknown as SessionEntry;
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

async function makeNotifyingCtx(
	notices: string[],
	threadId: string,
	branchEntries: SessionEntry[] = [],
): Promise<ExtensionContext> {
	const base = await makeCtx(threadId, branchEntries);
	return {
		...base,
		hasUI: true,
		ui: { notify: (message: string) => notices.push(message), select: async () => undefined, setStatus: () => {} },
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
		vi.restoreAllMocks();
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

	it("documents the todo gate and decisive completion in the update_goal description", () => {
		const { tools } = createGoalHarness();
		const description = tools.get("update_goal")?.description ?? "";
		expect(description).toMatch(/completion audit/i);
		expect(description).toMatch(/todo/i);
		expect(description).toMatch(/rejected while/i);
		expect(description).toMatch(/same turn/i);
		expect(description).toMatch(/unmistakably clear/i);
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

	it("treats an empty, whitespace-only, or null reason as omitted when completing a goal", async () => {
		for (const reason of ["", "   ", null]) {
			const { tools } = createGoalHarness();
			const ctx = await makeCtx(`thread/blank-reason-${String(reason)}`);
			const ref = storeRefFor(ctx);
			await tools
				.get("create_goal")
				?.execute("c1", { objective: "Complete despite sloppy args" }, undefined, undefined, ctx);

			await tools.get("update_goal")?.execute("u1", { status: "complete", reason }, undefined, undefined, ctx);

			expect((await readGoal(ref))?.status).toBe("complete");
		}
	});

	it("still rejects blocking with a blank reason", async () => {
		const { tools } = createGoalHarness();
		const ctx = await makeCtx("thread/blank-reason-blocked");
		await tools
			.get("create_goal")
			?.execute("c1", { objective: "Block with blank reason" }, undefined, undefined, ctx);

		await expect(
			tools.get("update_goal")?.execute("u1", { status: "blocked", reason: "  " }, undefined, undefined, ctx),
		).rejects.toThrow("reason is required");
		expect((await readGoal(storeRefFor(ctx)))?.status).toBe("active");
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

	it("pauses a goal when a provider error ends after retries are exhausted", async () => {
		const { tools, handlers, sent } = createGoalHarness();
		const notices: string[] = [];
		const ctx = await makeNotifyingCtx(notices, "thread-terminal-provider-error");
		await tools
			.get("create_goal")
			?.execute("c1", { objective: "Recover from provider errors" }, undefined, undefined, ctx);

		await runHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [assistantMessageWithStopReason("error")], willRetry: false },
			ctx,
		);

		expect(await readGoal(storeRefFor(ctx))).toMatchObject({
			status: "paused",
			blockedReason: "terminal provider error",
			blockedAt: expect.any(Number),
		});
		expect(notices).toEqual([]);
		expect(sent).toHaveLength(0);
	});

	it("persists a direct-user pause before agent start and keeps it across rejection and restart", async () => {
		const first = createGoalHarness();
		const ctx = await makeCtx("thread-immediate-user-pause");
		await first.tools
			.get("create_goal")
			?.execute("c1", { objective: "Stay stopped after direct input" }, undefined, undefined, ctx);
		const writeSpy = vi.spyOn(persistence, "writeGoalFile");

		await runHandlers(
			first.handlers,
			"input",
			{ type: "input", text: "Answer this instead", source: "interactive" },
			ctx,
		);

		expect(await readGoal(storeRefFor(ctx))).toMatchObject({
			status: "paused",
			blockedReason: "user-input",
		});
		expect(writeSpy).toHaveBeenCalledTimes(1);

		// Final provider admission can reject after this hook, so no agent_start follows.
		await runHandlers(first.handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
		expect(await readGoal(storeRefFor(ctx))).toMatchObject({ status: "paused", blockedReason: "user-input" });
		expect(writeSpy).toHaveBeenCalledTimes(1);

		const restarted = createGoalHarness();
		await runHandlers(restarted.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(restarted.sent).toHaveLength(0);
		expect(await readGoal(storeRefFor(ctx))).toMatchObject({ status: "paused", blockedReason: "user-input" });
		expect(writeSpy).toHaveBeenCalledTimes(1);
	});

	it("blocks delivery of a queued continuation when direct user input arrives after agent_end", async () => {
		const harness = createGoalHarness();
		const ctx = await makeCtx("thread-continuation-race");
		await harness.tools
			.get("create_goal")
			?.execute("c1", { objective: "Prevent continuation after user input" }, undefined, undefined, ctx);

		// Spy on MonitorAwareGoalContinuation.prototype.noteContinuationStarted to verify it is not called
		// after user input pauses the goal.
		const noteContinuationStartedSpy = vi.spyOn(MonitorAwareGoalContinuation.prototype, "noteContinuationStarted");

		// Agent starts and ends cleanly, queueing a continuation.
		await runHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
		await runHandlers(
			harness.handlers,
			"agent_end",
			{ type: "agent_end", messages: [assistantMessageWithStopReason("stop")] },
			ctx,
		);

		// At this point, a continuation has been queued (sent to the UI/API).
		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]?.message.customType).toBe("goal-continuation");
		const callsAfterQueue = noteContinuationStartedSpy.mock.calls.length;

		// Now user sends direct input BEFORE the queued continuation can start.
		await runHandlers(
			harness.handlers,
			"input",
			{ type: "input", text: "Do this instead", source: "interactive" },
			ctx,
		);

		// Goal should now be paused.
		const pausedGoal = await readGoal(storeRefFor(ctx));
		expect(pausedGoal).toMatchObject({
			status: "paused",
			blockedReason: "user-input",
		});

		try {
			// If agent_start fires (e.g., provider accepts the queued continuation before seeing the pause),
			// it should NOT call noteContinuationStarted() because continuationPending was cleared by the input handler.
			await runHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);

			// Verify noteContinuationStarted was never called after the input paused the goal.
			expect(noteContinuationStartedSpy.mock.calls.length).toBe(callsAfterQueue);

			// Goal must remain paused.
			expect(await readGoal(storeRefFor(ctx))).toMatchObject({
				status: "paused",
				blockedReason: "user-input",
			});
		} finally {
			noteContinuationStartedSpy.mockRestore();
		}
	});

	it("reactivates a user-paused goal only through explicit /goal resume", async () => {
		const { tools, commands, handlers, sent } = createGoalHarness();
		const ctx = await makeCtx("thread-explicit-resume");
		await tools
			.get("create_goal")
			?.execute("c1", { objective: "Wait for explicit resume" }, undefined, undefined, ctx);

		await runHandlers(
			handlers,
			"input",
			{ type: "input", text: "Answer this direct question", source: "interactive" },
			ctx,
		);
		await runHandlers(handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
		await runHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [assistantMessageWithStopReason("stop")] },
			ctx,
		);

		expect(await readGoal(storeRefFor(ctx))).toMatchObject({ status: "paused" });
		expect(sent).toHaveLength(0);

		await commands.get("goal")?.handler("resume", ctx);

		expect(await readGoal(storeRefFor(ctx))).toMatchObject({ status: "active" });
		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.customType).toBe("goal-continuation");
	});

	it("keeps a goal active while a provider-error retry is pending", async () => {
		const { tools, handlers, sent } = createGoalHarness();
		const notices: string[] = [];
		const ctx = await makeNotifyingCtx(notices, "thread-provider-retry-pending");
		await tools
			.get("create_goal")
			?.execute("c1", { objective: "Wait for retry recovery" }, undefined, undefined, ctx);

		await runHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [assistantMessageWithStopReason("error")], willRetry: true },
			ctx,
		);

		expect(await readGoal(storeRefFor(ctx))).toMatchObject({ status: "active" });
		expect(notices).toEqual([]);
		expect(sent).toHaveLength(0);
	});

	it("preserves the user-abort block reason", async () => {
		const { tools, handlers } = createGoalHarness();
		const ctx = await makeCtx("thread-user-abort-provider-guard");
		await tools.get("create_goal")?.execute("c1", { objective: "Allow interruption" }, undefined, undefined, ctx);

		await runHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runHandlers(
			handlers,
			"agent_end",
			{
				type: "agent_end",
				messages: [assistantMessageWithStopReason("aborted")],
				aborted: true,
				abortSource: "user",
				willRetry: false,
			},
			ctx,
		);

		expect(await readGoal(storeRefFor(ctx))).toMatchObject({
			status: "blocked",
			blockedReason: "user interrupted the turn",
		});
	});

	it("pauses a non-user aborted turn after retries are exhausted", async () => {
		const { tools, handlers } = createGoalHarness();
		const ctx = await makeCtx("thread-system-abort-provider-guard");
		await tools
			.get("create_goal")
			?.execute("c1", { objective: "Recover from provider aborts" }, undefined, undefined, ctx);

		await runHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runHandlers(
			handlers,
			"agent_end",
			{
				type: "agent_end",
				messages: [assistantMessageWithStopReason("aborted")],
				aborted: true,
				abortSource: "system",
				willRetry: false,
			},
			ctx,
		);

		expect(await readGoal(storeRefFor(ctx))).toMatchObject({
			status: "paused",
			blockedReason: "system abort",
			blockedAt: expect.any(Number),
		});
	});

	it("finalizes active terminal and user-abort paths with one Goal-file write", async () => {
		const scenarios = [
			{
				name: "length",
				message: assistantMessageWithStopReason("length"),
				endState: { willRetry: false },
				expected: { status: "paused", blockedReason: "output length" },
			},
			{
				name: "terminal provider error",
				message: assistantMessageWithStopReason("error"),
				endState: { willRetry: false },
				expected: { status: "paused", blockedReason: "terminal provider error" },
			},
			{
				name: "system abort",
				message: assistantMessageWithStopReason("aborted"),
				endState: { aborted: true, abortSource: "system" as const, willRetry: false },
				expected: { status: "paused", blockedReason: "system abort" },
			},
			{
				name: "user abort",
				message: assistantMessageWithStopReason("aborted"),
				endState: { aborted: true, abortSource: "user" as const, willRetry: false },
				expected: { status: "blocked", blockedReason: "user interrupted the turn" },
			},
		];

		for (const scenario of scenarios) {
			const { tools, handlers } = createGoalHarness();
			const ctx = await makeCtx(`thread-one-write-${scenario.name}`);
			await tools
				.get("create_goal")
				?.execute("c1", { objective: `Finalize ${scenario.name}` }, undefined, undefined, ctx);
			await runHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
			const writeSpy = vi.spyOn(persistence, "writeGoalFile");

			await runHandlers(
				handlers,
				"agent_end",
				{ type: "agent_end", messages: [scenario.message], ...scenario.endState },
				ctx,
			);

			expect(writeSpy, scenario.name).toHaveBeenCalledTimes(1);
			expect(await readGoal(storeRefFor(ctx))).toMatchObject(scenario.expected);
			writeSpy.mockRestore();
		}
	});

	it("keeps a continued clean agent_end within two writes and a goal-less end at zero", async () => {
		const active = createGoalHarness();
		const activeCtx = await makeCtx("thread-write-budget-continued");
		await active.tools
			.get("create_goal")
			?.execute("c1", { objective: "Continue within budget" }, undefined, undefined, activeCtx);
		await runHandlers(active.handlers, "agent_start", { type: "agent_start" }, activeCtx);
		const writeSpy = vi.spyOn(persistence, "writeGoalFile");

		await runHandlers(
			active.handlers,
			"agent_end",
			{ type: "agent_end", messages: [assistantMessageWithStopReason("stop")] },
			activeCtx,
		);

		expect(writeSpy.mock.calls.length).toBeLessThanOrEqual(2);
		writeSpy.mockClear();

		const goalLess = createGoalHarness();
		const goalLessCtx = await makeCtx("thread-write-budget-goalless");
		await runHandlers(goalLess.handlers, "agent_start", { type: "agent_start" }, goalLessCtx);
		await runHandlers(
			goalLess.handlers,
			"agent_end",
			{ type: "agent_end", messages: [assistantMessageWithStopReason("stop")] },
			goalLessCtx,
		);

		expect(writeSpy).not.toHaveBeenCalled();
	});

	it("rejects update_goal complete while todo tasks remain open, naming them", async () => {
		const { tools } = createGoalHarness();
		const ctx = await makeCtx("thread-todo-open", [
			todoStateEntry([
				{
					name: "Build",
					tasks: [
						{ content: "write tests", status: "completed" },
						{ content: "ship the fix", status: "pending" },
						{ content: "run QA", status: "in_progress" },
					],
				},
			]),
		]);
		await tools.get("create_goal")?.execute("c1", { objective: "Ship gated" }, undefined, undefined, ctx);

		await expect(
			tools.get("update_goal")?.execute("u1", { status: "complete" }, undefined, undefined, ctx),
		).rejects.toThrow(/open todo task/i);
		await expect(
			tools.get("update_goal")?.execute("u2", { status: "complete" }, undefined, undefined, ctx),
		).rejects.toThrow(/"ship the fix", "run QA"/);
		expect((await readGoal(storeRefFor(ctx)))?.status).toBe("active");
	});

	it("allows update_goal complete when every todo task is terminal", async () => {
		const { tools } = createGoalHarness();
		const ctx = await makeCtx("thread-todo-done", [
			todoStateEntry([
				{
					name: "Build",
					tasks: [
						{ content: "write tests", status: "completed" },
						{ content: "optional polish", status: "abandoned" },
					],
				},
			]),
		]);
		await tools.get("create_goal")?.execute("c1", { objective: "Ship done" }, undefined, undefined, ctx);
		await tools.get("update_goal")?.execute("u1", { status: "complete" }, undefined, undefined, ctx);
		expect((await readGoal(storeRefFor(ctx)))?.status).toBe("complete");
	});

	it("allows update_goal complete when no todo list exists", async () => {
		const { tools } = createGoalHarness();
		const ctx = await makeCtx("thread-todo-none");
		await tools.get("create_goal")?.execute("c1", { objective: "Ship untracked" }, undefined, undefined, ctx);
		await tools.get("update_goal")?.execute("u1", { status: "complete" }, undefined, undefined, ctx);
		expect((await readGoal(storeRefFor(ctx)))?.status).toBe("complete");
	});

	it("still allows update_goal blocked while todo tasks remain open", async () => {
		const { tools } = createGoalHarness();
		const ctx = await makeCtx("thread-todo-blocked", [
			todoStateEntry([{ name: "Build", tasks: [{ content: "ship the fix", status: "pending" }] }]),
		]);
		await tools.get("create_goal")?.execute("c1", { objective: "Blockable" }, undefined, undefined, ctx);
		await tools
			.get("update_goal")
			?.execute("u1", { status: "blocked", reason: "Waiting on an external decision" }, undefined, undefined, ctx);
		expect((await readGoal(storeRefFor(ctx)))?.status).toBe("blocked");
	});

	it("gates on the latest todo state in the branch", async () => {
		const { tools } = createGoalHarness();
		const ctx = await makeCtx("thread-todo-latest", [
			todoStateEntry([{ name: "Build", tasks: [{ content: "ship the fix", status: "pending" }] }]),
			todoStateEntry([{ name: "Build", tasks: [{ content: "ship the fix", status: "completed" }] }]),
		]);
		await tools.get("create_goal")?.execute("c1", { objective: "Ship latest" }, undefined, undefined, ctx);
		await tools.get("update_goal")?.execute("u1", { status: "complete" }, undefined, undefined, ctx);
		expect((await readGoal(storeRefFor(ctx)))?.status).toBe("complete");
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

describe("goal extension reload does not auto-start a stopped agent", () => {
	it("does not queue a continuation on session_start reason 'reload'", async () => {
		const { tools, handlers, sent } = createGoalHarness();
		const ctx = await makeCtx("thread-reload-noop");
		await tools.get("create_goal")?.execute("c1", { objective: "Keep going" }, undefined, undefined, ctx);

		await runHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		expect(sent).toHaveLength(0);
	});

	it("still queues a continuation on session_start reason 'startup'", async () => {
		const { tools, handlers, sent } = createGoalHarness();
		const ctx = await makeCtx("thread-startup-cont");
		await tools.get("create_goal")?.execute("c1", { objective: "Keep going" }, undefined, undefined, ctx);

		await runHandlers(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.customType).toBe("goal-continuation");
	});

	it("still queues a continuation on session_start reason 'resume'", async () => {
		const { tools, handlers, sent } = createGoalHarness();
		const ctx = await makeCtx("thread-resume-cont");
		await tools.get("create_goal")?.execute("c1", { objective: "Keep going" }, undefined, undefined, ctx);

		await runHandlers(handlers, "session_start", { type: "session_start", reason: "resume" }, ctx);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.customType).toBe("goal-continuation");
	});
});

describe("goal extension session_start migration-lite admission", () => {
	it("pauses and notifies when a resumed session ends in a continuation flood", async () => {
		const { tools, handlers, sent } = createGoalHarness();
		const notices: string[] = [];
		const ctx = await makeNotifyingCtx(notices, "thread-flooded-resume", [
			userMessageEntry(),
			...goalContinuationEntries(300),
		]);
		await tools.get("create_goal")?.execute("c1", { objective: "Keep going" }, undefined, undefined, ctx);

		await runHandlers(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(sent).toHaveLength(0);
		expect(notices).toContainEqual(
			"Goal paused after recovering 300 historical continuations. Run /goal resume to continue.",
		);
		expect((await readGoal(storeRefFor(ctx)))?.status).toBe("paused");
	});

	it("queues a continuation normally when only a few trailing continuations exist", async () => {
		const { tools, handlers, sent } = createGoalHarness();
		const notices: string[] = [];
		const ctx = await makeNotifyingCtx(notices, "thread-healthy-resume", [
			userMessageEntry(),
			...goalContinuationEntries(3),
		]);
		await tools.get("create_goal")?.execute("c1", { objective: "Keep going" }, undefined, undefined, ctx);

		await runHandlers(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.customType).toBe("goal-continuation");
		expect(notices).toEqual([]);
	});

	it("restores current-segment continuations even when a real user message follows them", async () => {
		const { tools, handlers, sent } = createGoalHarness();
		const notices: string[] = [];
		const ctx = await makeNotifyingCtx(notices, "thread-flood-then-user", [
			...goalContinuationEntries(300),
			userMessageEntry(),
		]);
		await tools.get("create_goal")?.execute("c1", { objective: "Keep going" }, undefined, undefined, ctx);

		await runHandlers(handlers, "session_start", { type: "session_start", reason: "resume" }, ctx);

		expect(sent).toHaveLength(0);
		expect(await readGoal(storeRefFor(ctx))).toMatchObject({
			status: "paused",
			consecutiveContinuations: 300,
		});
		expect(notices).toContainEqual(
			"Goal paused after recovering 300 historical continuations. Run /goal resume to continue.",
		);
	});

	it("stays paused after a real user prompt follows a suppressed load", async () => {
		const { tools, handlers, sent } = createGoalHarness();
		const notices: string[] = [];
		const ctx = await makeNotifyingCtx(notices, "thread-suppressed-then-prompt", [
			userMessageEntry(),
			...goalContinuationEntries(300),
		]);
		await tools.get("create_goal")?.execute("c1", { objective: "Keep going" }, undefined, undefined, ctx);
		await runHandlers(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
		expect(sent).toHaveLength(0);

		await runHandlers(handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
		await runHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [assistantMessageWithStopReason("stop")] },
			ctx,
		);
		expect(sent).toHaveLength(0);
		expect((await readGoal(storeRefFor(ctx)))?.status).toBe("paused");
	});

	it("keeps reload sessions inert even with a flooded branch (no queue, no suppression notice)", async () => {
		const { tools, handlers, sent } = createGoalHarness();
		const notices: string[] = [];
		const ctx = await makeNotifyingCtx(notices, "thread-flooded-reload", [
			userMessageEntry(),
			...goalContinuationEntries(300),
		]);
		await tools.get("create_goal")?.execute("c1", { objective: "Keep going" }, undefined, undefined, ctx);

		await runHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		expect(sent).toHaveLength(0);
		expect(notices).toEqual([]);
		expect((await readGoal(storeRefFor(ctx)))?.status).toBe("active");
	});
});

function userMessageEntry(): SessionEntry {
	return {
		type: "message",
		message: {
			role: "user",
			content: [{ type: "text", text: "a real user message" }],
			timestamp: Date.now(),
		},
	} as unknown as SessionEntry;
}

function goalContinuationEntries(count: number): SessionEntry[] {
	return Array.from({ length: count }, () => ({
		type: "custom_message",
		customType: "goal-continuation",
		content: "continue the goal",
		display: false,
	})) as unknown as SessionEntry[];
}

describe("goal extension session_abort blocks an active goal outside an agent run", () => {
	it("blocks an active goal when session_abort fires (abort during retry backoff or queued continuation)", async () => {
		const { tools, handlers, sent } = createGoalHarness();
		const ctx = await makeCtx("thread-session-abort-gap");
		await tools.get("create_goal")?.execute("c1", { objective: "Keep going" }, undefined, undefined, ctx);
		// Simulate the gap case: agent_end fired earlier (error/retry), goal is still active,
		// then user aborts outside an active run -> session_abort fires.
		await runHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [assistantMessageWithStopReason("error")] },
			ctx,
		);
		expect((await readGoal(storeRefFor(ctx)))?.status).toBe("active");

		await runHandlers(handlers, "session_abort", { type: "session_abort" }, ctx);

		const goal = await readGoal(storeRefFor(ctx));
		expect(goal?.status).toBe("blocked");
		expect(goal?.blockedReason).toBeTruthy();
		expect(sent).toHaveLength(0);
	});

	it("does not block a goal that is already blocked or complete on session_abort", async () => {
		const { tools, handlers } = createGoalHarness();
		const ctx = await makeCtx("thread-session-abort-already-blocked");
		await tools.get("create_goal")?.execute("c1", { objective: "Done waiting" }, undefined, undefined, ctx);
		await tools
			.get("update_goal")
			?.execute("u1", { status: "blocked", reason: "Already blocked" }, undefined, undefined, ctx);

		await runHandlers(handlers, "session_abort", { type: "session_abort" }, ctx);

		const goal = await readGoal(storeRefFor(ctx));
		expect(goal?.status).toBe("blocked");
		expect(goal?.blockedReason).toBe("Already blocked");
	});

	it("does nothing on session_abort when there is no goal", async () => {
		const { handlers } = createGoalHarness();
		const ctx = await makeCtx("thread-session-abort-no-goal");

		await runHandlers(handlers, "session_abort", { type: "session_abort" }, ctx);

		expect(await readGoal(storeRefFor(ctx))).toBeNull();
	});
});

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

function assistantMessageWithStopReason(stopReason: "aborted" | "error" | "length" | "stop"): AgentMessage {
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
