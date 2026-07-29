import { strict as assert } from "node:assert";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as persistence from "../../../src/core/extensions/builtin/goal/persistence.ts";
import { readGoal, writeGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import * as transitions from "../../../src/core/extensions/builtin/goal/transitions.ts";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	makeGoalContext,
	runGoalHandlers,
} from "../goal-monitor-test-harness.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const GOAL_CONTINUATION_MESSAGE_TYPE = "goal-continuation";
const GOAL_CONTINUATION_CAP = 8;
const LARGE_RECOVERY_BRANCH_SIZE = 7_368;

const harnesses: Harness[] = [];

afterEach(async () => {
	vi.useRealTimers();
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	await cleanupGoalMonitorTempDirs();
});

function goalStoreRef(ctx: ExtensionContext) {
	return {
		baseDir: join(ctx.sessionManager.getSessionDir(), "extensions", "goal"),
		threadId: ctx.sessionManager.getSessionId(),
	};
}

function cleanAssistantStopWithText(text: string): AgentMessage {
	const message = cleanAssistantStop();
	if (message.role !== "assistant") throw new Error("Expected an assistant message");
	return { ...message, content: [{ type: "text", text }] };
}

function assistantStopWithReason(reason: "length" | "error" | "aborted", text: string): AgentMessage {
	const message = cleanAssistantStopWithText(text);
	if (message.role !== "assistant") throw new Error("Expected an assistant message");
	return { ...message, stopReason: reason };
}

async function createActiveGoal(
	harness: ReturnType<typeof createGoalHarness>,
	ctx: ExtensionContext,
	objective: string,
): Promise<void> {
	const createGoal = harness.tools.get("create_goal");
	if (createGoal === undefined) throw new Error("Goal tool was not registered");
	await createGoal.execute("issue-447-create", { objective }, undefined, undefined, ctx);
}

async function runContinuationTurn(
	harness: ReturnType<typeof createGoalHarness>,
	ctx: ExtensionContext,
	message: AgentMessage,
	endState: { willRetry?: boolean; aborted?: boolean; abortSource?: "user" | "system" } = {},
): Promise<void> {
	await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
	await runGoalHandlers(harness.handlers, "agent_end", { type: "agent_end", messages: [message], ...endState }, ctx);
}

function continuationEntries(count: number, firstTimestampSeconds = 1): SessionEntry[] {
	return Array.from({ length: count }, (_, index) => ({
		type: "custom_message",
		id: `continuation-${firstTimestampSeconds}-${index}`,
		parentId: null,
		timestamp: new Date((firstTimestampSeconds + index) * 1000).toISOString(),
		customType: GOAL_CONTINUATION_MESSAGE_TYPE,
		content: `historical continuation ${index}`,
		display: false,
	}));
}

function recoveryBranch(sinceSeconds: number, continuationCount: number, totalEntries: number): SessionEntry[] {
	const continuations = continuationEntries(continuationCount, sinceSeconds + 1);
	const padding = Array.from({ length: totalEntries - continuationCount }, (_, index) => ({
		type: "custom" as const,
		id: `padding-${index}`,
		parentId: null,
		timestamp: new Date((sinceSeconds + continuationCount + index + 1) * 1000).toISOString(),
		customType: "issue-447-padding",
		data: { index },
	}));
	return [...continuations, ...padding];
}

function contextWithBranch(ctx: ExtensionContext, branch: SessionEntry[]): ExtensionContext {
	return {
		...ctx,
		sessionManager: {
			...ctx.sessionManager,
			getBranch: () => branch,
		},
	} as ExtensionContext;
}

describe("issue #447: goal continuation guardrails", () => {
	it("caps 50 clean synthetic goal turns at eight and never queues more than one pending continuation", async () => {
		const notices: string[] = [];
		const harness = createGoalHarness();
		const ctx = await makeGoalContext(notices, "issue-447-cap");
		await createActiveGoal(harness, ctx, "Finish the issue #447 regression");
		await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		for (let turn = 1; turn <= 50; turn++) {
			const promptsBeforeTurn = harness.sent.length;
			await runContinuationTurn(harness, ctx, cleanAssistantStopWithText(`completed distinct step ${turn}`));

			// agent_start consumes the previous hidden follow-up. At most one new follow-up
			// may be pending after the clean end, even while the goal remains active.
			expect(harness.sent.length - promptsBeforeTurn).toBeLessThanOrEqual(1);
		}

		expect(harness.sent).toHaveLength(GOAL_CONTINUATION_CAP);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "paused",
			blockedReason: "continuation cap reached",
		});
		expect(notices).toContainEqual(expect.stringContaining("continuation cap reached"));
	});

	it("drops consumed goal-continuation prompts after the next direct user request", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.sessionManager.appendMessage({ role: "user", content: "begin the goal", timestamp: 1 });
		for (let index = 0; index < 300; index++) {
			harness.sessionManager.appendCustomMessageEntry(
				GOAL_CONTINUATION_MESSAGE_TYPE,
				`consumed continuation ${index}`,
				false,
			);
		}
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage("the live continuation was received")]);

		await harness.session.prompt("make the next provider request");

		const request = harness.faux.getCallLog()[0];
		if (request === undefined) throw new Error("Expected one faux-provider request");
		const continuationPrompts = request.context.messages.filter(
			(message) => message.role === "user" && getMessageText(message).startsWith("consumed continuation"),
		);
		expect(continuationPrompts).toHaveLength(0);
	});

	it("pauses on the first length stop without queuing a recovery", async () => {
		const notices: string[] = [];
		const harness = createGoalHarness();
		const ctx = await makeGoalContext(notices, "issue-447-length");
		await createActiveGoal(harness, ctx, "Finish the truncated response");
		await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		await runContinuationTurn(harness, ctx, assistantStopWithReason("length", "first response cut off"));

		expect(harness.sent).toHaveLength(0);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "paused",
			blockedReason: "output length",
			blockedAt: expect.any(Number),
		});
	});

	it("pauses immediately after direct real-user input", async () => {
		const notices: string[] = [];
		const harness = createGoalHarness();
		const ctx = await makeGoalContext(notices, "issue-447-user-pause");
		await createActiveGoal(harness, ctx, "Answer the direct user question first");
		await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		await runGoalHandlers(
			harness.handlers,
			"input",
			{ type: "input", text: "Answer me directly", source: "interactive" },
			ctx,
		);
		await runGoalHandlers(harness.handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
		await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			harness.handlers,
			"agent_end",
			{ type: "agent_end", messages: [cleanAssistantStopWithText("answered the user directly")] },
			ctx,
		);
		expect(harness.sent).toHaveLength(0);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "paused" });
	});

	it("pauses on a terminal provider error without queuing a continuation", async () => {
		const notices: string[] = [];
		const harness = createGoalHarness();
		const ctx = await makeGoalContext(notices, "issue-447-terminal-error");
		await createActiveGoal(harness, ctx, "Recover only when the provider can retry");
		await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		await runContinuationTurn(harness, ctx, assistantStopWithReason("error", "provider exhausted retries"), {
			willRetry: false,
		});

		expect(harness.sent).toHaveLength(0);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "paused",
			blockedReason: "terminal provider error",
			blockedAt: expect.any(Number),
		});
	});

	it.each([
		{ source: "user" as const, expectedStatus: "blocked", expectedReason: "user interrupted the turn" },
		{ source: "system" as const, expectedStatus: "paused", expectedReason: "system abort" },
	])(
		"distinguishes $source aborts without queuing a continuation",
		async ({ source, expectedStatus, expectedReason }) => {
			const notices: string[] = [];
			const harness = createGoalHarness();
			const ctx = await makeGoalContext(notices, `issue-447-${source}-abort`);
			await createActiveGoal(harness, ctx, `Stop safely after a ${source} abort`);
			await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

			await runContinuationTurn(harness, ctx, assistantStopWithReason("aborted", `request aborted by ${source}`), {
				aborted: true,
				abortSource: source,
				willRetry: false,
			});

			expect(harness.sent).toHaveLength(0);
			const goal = await readGoal(goalStoreRef(ctx));
			expect(goal).toMatchObject({ status: expectedStatus });
			expect(goal?.blockedReason).toBe(expectedReason);
		},
	);

	it("restores the max legacy count in one 7,368-entry in-memory traversal and one Goal write", async () => {
		const notices: string[] = [];
		const harness = createGoalHarness();
		const baseCtx = await makeGoalContext(notices, "issue-447-legacy-281");
		await createActiveGoal(harness, baseCtx, "Resume safely after the issue #447 historical flood");
		const ref = goalStoreRef(baseCtx);
		const active = await readGoal(ref);
		if (active === null) throw new Error("Expected an active Goal fixture");
		const since = active.lastStartedAt ?? active.createdAt;
		await writeGoal(ref, { ...active, lastStartedAt: since, consecutiveContinuations: 3 });

		const entries = recoveryBranch(since, 281, LARGE_RECOVERY_BRANCH_SIZE);
		let entryVisits = 0;
		const countedEntries = new Proxy(entries, {
			get(target, property, receiver) {
				if (typeof property === "string" && /^\d+$/.test(property)) entryVisits += 1;
				return Reflect.get(target, property, receiver);
			},
		});
		let branchReads = 0;
		const ctx = {
			...contextWithBranch(baseCtx, countedEntries),
			sessionManager: {
				...baseCtx.sessionManager,
				getBranch: () => {
					branchReads += 1;
					return countedEntries;
				},
			},
		} as ExtensionContext;
		const sessionFile = ctx.sessionManager.getSessionFile();
		assert.ok(sessionFile);
		const originalJsonl = `${JSON.stringify({ type: "session", id: "issue-447-legacy-281" })}\n${JSON.stringify({
			type: "custom_message",
			customType: GOAL_CONTINUATION_MESSAGE_TYPE,
			content: "historical continuation 280",
		})}\n`;
		await writeFile(sessionFile, originalJsonl, "utf8");
		const readSpy = vi.spyOn(persistence, "readGoalFile");
		const writeSpy = vi.spyOn(persistence, "writeGoalFile");
		const transitionSpy = vi.spyOn(transitions, "transitionGoalStatus");

		await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(harness.sent).toHaveLength(0);
		expect(branchReads).toBe(1);
		expect(entryVisits).toBe(LARGE_RECOVERY_BRANCH_SIZE);
		expect(readSpy).toHaveBeenCalledTimes(1);
		expect(writeSpy).toHaveBeenCalledTimes(1);
		expect(transitionSpy).toHaveBeenCalledWith(
			expect.objectContaining({ status: "active", consecutiveContinuations: 281 }),
			"paused",
			"system",
			"continuation cap reached",
			expect.any(Number),
		);
		readSpy.mockRestore();
		expect(await readGoal(ref)).toMatchObject({
			status: "paused",
			blockedReason: "continuation cap reached",
			consecutiveContinuations: 281,
		});
		assert.ok(sessionFile);
		expect(await readFile(sessionFile, "utf8")).toBe(originalJsonl);
	});

	it("restores seven current-segment continuations without granting a fresh restart allowance", async () => {
		const notices: string[] = [];
		const first = createGoalHarness();
		const baseCtx = await makeGoalContext(notices, "issue-447-legacy-seven");
		await createActiveGoal(first, baseCtx, "Preserve the remaining continuation allowance");
		const ref = goalStoreRef(baseCtx);
		const active = await readGoal(ref);
		if (active === null) throw new Error("Expected an active Goal fixture");
		const since = active.lastStartedAt ?? active.createdAt;
		const legacy = { ...active, lastStartedAt: since };
		delete legacy.consecutiveContinuations;
		await writeGoal(ref, legacy);
		const branch = [...continuationEntries(20, since - 100), ...continuationEntries(7, since + 1)];
		const ctx = contextWithBranch(baseCtx, branch);

		await runGoalHandlers(first.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(first.sent).toHaveLength(1);
		expect(await readGoal(ref)).toMatchObject({ status: "active", consecutiveContinuations: 8 });

		const restarted = createGoalHarness();
		// Subscribe before triggering the restored-count >= 8 branch
		const guardTripped = restarted.events.waitFor("goal_continuation_guard_tripped");
		await runGoalHandlers(restarted.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
		// Await the cap event with count 8
		const event = await guardTripped;
		expect(event).toMatchObject({ reason: "cap", count: 8 });

		expect(restarted.sent).toHaveLength(0);
		expect(await readGoal(ref)).toMatchObject({
			status: "paused",
			blockedReason: "continuation cap reached",
			consecutiveContinuations: 8,
		});
	});
});
