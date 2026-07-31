import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
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

function assistantStopWithReason(reason: "length" | "error", text: string): AgentMessage {
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
	willRetry?: boolean,
): Promise<void> {
	await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
	await runGoalHandlers(harness.handlers, "agent_end", { type: "agent_end", messages: [message], willRetry }, ctx);
}

function continuationEntries(count: number): SessionEntry[] {
	return Array.from({ length: count }, (_, index) => ({
		type: "custom_message",
		customType: GOAL_CONTINUATION_MESSAGE_TYPE,
		content: `historical continuation ${index}`,
		display: false,
	})) as unknown as SessionEntry[];
}

function floodedBranch(): SessionEntry[] {
	return [
		{
			type: "message",
			message: { role: "user", content: "start the goal", timestamp: 1 },
		} as unknown as SessionEntry,
		...continuationEntries(300),
	];
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
	it("keeps 50 distinct progress turns active and never queues more than one pending continuation", async () => {
		const notices: string[] = [];
		const harness = createGoalHarness();
		const ctx = await makeGoalContext(notices, "issue-447-distinct-progress");
		await createActiveGoal(harness, ctx, "Finish the issue #447 regression");
		await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		for (let turn = 1; turn <= 50; turn++) {
			const promptsBeforeTurn = harness.sent.length;
			await runContinuationTurn(harness, ctx, cleanAssistantStopWithText(`completed distinct step ${turn}`));

			// agent_start consumes the previous hidden follow-up. At most one new follow-up
			// may be pending after the clean end, even while the goal remains active.
			expect(harness.sent.length - promptsBeforeTurn).toBeLessThanOrEqual(1);
		}

		expect(harness.sent).toHaveLength(50);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "active",
			consecutiveContinuations: 1,
		});
		expect(notices).not.toContainEqual(expect.stringContaining("continuation cap reached"));
	});

	it("does not send consumed goal-continuation prompts in the next faux-provider request", async () => {
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
		expect(continuationPrompts).toHaveLength(1);
		expect(getMessageText(continuationPrompts[0]!)).toBe("consumed continuation 299");
	});

	it("allows one truncation recovery, then blocks rather than looping on length stops", async () => {
		const notices: string[] = [];
		const harness = createGoalHarness();
		const ctx = await makeGoalContext(notices, "issue-447-length");
		await createActiveGoal(harness, ctx, "Finish the truncated response");
		await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		await runContinuationTurn(harness, ctx, assistantStopWithReason("length", "first response cut off"));
		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]?.message.content).toContain("cut off");
		expect(harness.sent[0]?.message.content).not.toContain("<untrusted_objective>");

		await runContinuationTurn(harness, ctx, assistantStopWithReason("length", "second response cut off"));
		expect(harness.sent).toHaveLength(1);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "blocked",
			blockedReason: "output truncation repeated",
		});
	});

	it("leaves an active Goal idle after a direct user message without a delayed resurrection", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const harness = createGoalHarness();
		const ctx = await makeGoalContext(notices, "issue-447-user-grace");
		await createActiveGoal(harness, ctx, "Answer the direct user question first");
		await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		await runGoalHandlers(
			harness.handlers,
			"input",
			{ type: "input", inputId: "grace-turn", text: "continue", source: "interactive" },
			ctx,
		);
		await runGoalHandlers(
			harness.handlers,
			"input_disposition",
			{ type: "input_disposition", inputId: "grace-turn", disposition: "started" },
			ctx,
		);
		await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			harness.handlers,
			"agent_end",
			{ type: "agent_end", messages: [cleanAssistantStopWithText("answered the user directly")] },
			ctx,
		);

		expect(harness.sent).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(harness.sent).toHaveLength(0);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active", consecutiveContinuations: 0 });
	});

	it("blocks the goal when a terminal provider error has no retry remaining", async () => {
		const notices: string[] = [];
		const harness = createGoalHarness();
		const ctx = await makeGoalContext(notices, "issue-447-terminal-error");
		await createActiveGoal(harness, ctx, "Recover only when the provider can retry");
		await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		await runContinuationTurn(harness, ctx, assistantStopWithReason("error", "provider exhausted retries"), false);

		expect(harness.sent).toHaveLength(0);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "blocked",
			blockedReason: "provider error ended the turn (retries exhausted)",
		});
		expect(notices).toContainEqual(expect.stringContaining("provider error ended the turn"));
	});

	it("does not replay hundreds of trailing continuations when the flooded session loads", async () => {
		const notices: string[] = [];
		const harness = createGoalHarness();
		const baseCtx = await makeGoalContext(notices, "issue-447-flooded-load");
		const ctx = contextWithBranch(baseCtx, floodedBranch());
		await createActiveGoal(harness, ctx, "Resume safely after a historical flood");

		await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(harness.sent).toHaveLength(0);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active" });
		expect(notices).toContainEqual(
			"Goal auto-continuation suppressed for this resumed session (300 historical continuations). Send a message to resume.",
		);
	});
});
