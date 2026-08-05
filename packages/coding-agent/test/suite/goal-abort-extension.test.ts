import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import goalExtension from "../../src/core/extensions/builtin/goal/index.ts";
import { createGoal, readGoal, updateGoal } from "../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../src/core/extensions/builtin/goal/store-ref.ts";
import type { GoalStatus } from "../../src/core/extensions/builtin/goal/types.ts";
import ttsrExtension from "../../src/core/extensions/builtin/ttsr/index.ts";
import { createHarness, type Harness } from "./harness.ts";

type AgentEndSnapshot = {
	aborted: boolean | undefined;
	abortSource: "user" | "system" | undefined;
	status: GoalStatus | undefined;
	tokensUsed: number | undefined;
	pendingMessages: boolean;
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	if (!resolve) throw new Error("Deferred resolver was not initialized");
	return { promise, resolve };
}

describe("goal abort lifecycle through the agent session", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("keeps an ESC interruption block through the next user run while allowing an explicit completion", async () => {
		const streamStarted = deferred();
		const agentEnds: AgentEndSnapshot[] = [];
		const statusesAtAgentStart: GoalStatus[] = [];
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				goalExtension,
				(pi) => {
					pi.on("message_update", (event) => {
						if (event.message.role === "assistant") streamStarted.resolve();
					});
					pi.on("agent_start", async (_event, ctx) => {
						const goal = await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd));
						if (goal) statusesAtAgentStart.push(goal.status);
					});
					pi.on("agent_end", async (event, ctx) => {
						const goal = await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd));
						agentEnds.push({
							aborted: event.aborted,
							abortSource: event.abortSource,
							status: goal?.status,
							tokensUsed: goal?.tokensUsed,
							pendingMessages: ctx.hasPendingMessages(),
						});
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const ref = goalStoreRef(harness.sessionManager, harness.tempDir);
		await createGoal(ref, "Finish the interrupted task");
		harness.setResponses([fauxAssistantMessage("streaming response ".repeat(4_000))]);

		const interruptedRun = harness.session.prompt("start the active goal");
		await streamStarted.promise;
		await harness.session.abort();
		await interruptedRun;

		expect(agentEnds).toEqual([
			expect.objectContaining({
				aborted: true,
				abortSource: "user",
				status: "blocked",
				tokensUsed: expect.any(Number),
				pendingMessages: false,
			}),
		]);
		expect(agentEnds[0]?.tokensUsed).toBeGreaterThan(0);
		expect(await readGoal(ref)).toMatchObject({
			status: "blocked",
			blockedReason: "user interrupted the turn",
		});

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("completed after resuming"),
		]);
		await harness.session.prompt("continue after interruption");

		expect(statusesAtAgentStart).toEqual(["active", "blocked"]);
		expect((await readGoal(ref))?.status).toBe("complete");
	});

	it("does not mark a normally completed agent run as aborted", async () => {
		const observed: Array<{ aborted: boolean | undefined; abortSource: string | undefined }> = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", (event) => {
						observed.push({ aborted: event.aborted, abortSource: event.abortSource });
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([fauxAssistantMessage("normal completion")]);

		await harness.session.prompt("run normally");

		expect(observed).toEqual([{ aborted: undefined, abortSource: undefined }]);
	});

	it("keeps an active monitored Goal live across a TTSR system abort", async () => {
		const abortSources: Array<string | undefined> = [];
		let resolveScheduledContinuation: ((data: unknown) => void) | undefined;
		const scheduledContinuation = new Promise<unknown>((resolve) => {
			resolveScheduledContinuation = resolve;
		});
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				goalExtension,
				ttsrExtension,
				(pi) => {
					pi.on("session_start", () => {
						pi.events?.emit("terminal_monitor_state", { activeCount: 1 });
					});
					pi.events?.on("goal_continuation_scheduled", (data) => resolveScheduledContinuation?.(data));
					pi.on("agent_end", (event) => {
						abortSources.push(event.abortSource);
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const ref = goalStoreRef(harness.sessionManager, harness.tempDir);
		await createGoal(ref, "Keep waiting for the live monitor");
		harness.setResponses([
			fauxAssistantMessage([fauxText('<unavailable-tool-call name="read"> inert imitation')]),
			fauxAssistantMessage("recovered after the stream rule"),
		]);

		await harness.session.prompt("continue monitoring");

		expect(abortSources).toContain("system");
		expect(abortSources).not.toContain("user");
		expect(abortSources).toContain(undefined);
		expect(harness.faux.getCallLog()).toHaveLength(2);
		expect(await readGoal(ref)).toMatchObject({ status: "active" });
		expect(await scheduledContinuation).toEqual(expect.objectContaining({ delayMs: 240_000 }));
	});

	it("keeps a model-authored block blocked on ordinary direct input", async () => {
		const statusesAtBeforeAgentStart: GoalStatus[] = [];
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				goalExtension,
				(pi) => {
					pi.on("before_agent_start", async (_event, ctx) => {
						const goal = await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd));
						if (goal) statusesAtBeforeAgentStart.push(goal.status);
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const ref = goalStoreRef(harness.sessionManager, harness.tempDir);
		await createGoal(ref, "Wait for the user");
		await updateGoal(ref, { status: "blocked", reason: "waiting on the user" });

		harness.setResponses([fauxAssistantMessage("resumed and done")]);
		await harness.session.prompt("user returns");

		expect(statusesAtBeforeAgentStart).toEqual(["blocked"]);
		expect((await readGoal(ref))?.status).toBe("blocked");
	});
});
