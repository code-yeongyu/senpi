import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readGoal, updateGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	makeGoalContext,
	runGoalHandlers,
	waitForSentCount,
} from "../goal-monitor-test-harness.ts";

const GOAL_CONTINUATION_MESSAGE_TYPE = "goal-continuation";

// The unattended budget is a policy pin, mirroring how issue-447 pins its 50-turn
// bound. It must stay above the #447 distinct-progress pin (50) and above an
// 8-hour monitor-backstop cadence (~120 deliveries at 240s).
const UNATTENDED_LIMIT = 150;
const UNATTENDED_BLOCKED_REASON = "unattended continuation limit reached";

afterEach(async () => {
	vi.useRealTimers();
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

async function createActiveGoal(
	harness: ReturnType<typeof createGoalHarness>,
	ctx: ExtensionContext,
	objective: string,
): Promise<void> {
	const createGoal = harness.tools.get("create_goal");
	if (createGoal === undefined) throw new Error("Goal tool was not registered");
	await createGoal.execute("issue-1139-create", { objective }, undefined, undefined, ctx);
}

async function runContinuationTurn(
	harness: ReturnType<typeof createGoalHarness>,
	ctx: ExtensionContext,
	message: AgentMessage,
): Promise<void> {
	await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
	await runGoalHandlers(harness.handlers, "agent_end", { type: "agent_end", messages: [message] }, ctx);
}

async function runAcceptedDirectInput(
	harness: ReturnType<typeof createGoalHarness>,
	ctx: ExtensionContext,
	inputId: string,
): Promise<void> {
	await runGoalHandlers(
		harness.handlers,
		"input",
		{ type: "input", inputId, text: "continue", source: "interactive" },
		ctx,
	);
	await runGoalHandlers(
		harness.handlers,
		"input_disposition",
		{ type: "input_disposition", inputId, disposition: "started" },
		ctx,
	);
}

describe("issue #1139: unattended continuation backstop", () => {
	it("blocks an active goal after the unattended limit despite varied toolless narration", {
		timeout: 60_000,
	}, async () => {
		const notices: string[] = [];
		const harness = createGoalHarness();
		const ctx = await makeGoalContext(notices, "issue-1139-unattended-limit");
		await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
		await createActiveGoal(harness, ctx, "Reproduce the #1139 varied-narration stall");

		// Every turn varies its narration, so the #539/#567 progress semantics reset
		// the consecutive streak each time and the cap can never accumulate.
		for (let turn = 1; turn <= UNATTENDED_LIMIT + 1; turn++) {
			const promptsBeforeTurn = harness.sent.length;
			await runContinuationTurn(harness, ctx, cleanAssistantStopWithText(`varied status narration ${turn}`));
			expect(harness.sent.length - promptsBeforeTurn).toBeLessThanOrEqual(1);
		}

		expect(harness.sent).toHaveLength(UNATTENDED_LIMIT);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "blocked",
			blockedReason: UNATTENDED_BLOCKED_REASON,
		});
		expect(notices).toContainEqual(
			`Goal continuation blocked: ${UNATTENDED_BLOCKED_REASON}. Send any message to resume.`,
		);
		expect(harness.events.emitted).toContainEqual(
			expect.objectContaining({
				channel: "goal_continuation_guard_tripped",
				data: expect.objectContaining({ reason: "unattended" }),
			}),
		);
	});

	it("counts unattended deliveries and resets the budget on accepted direct input", async () => {
		const notices: string[] = [];
		const harness = createGoalHarness();
		const ctx = await makeGoalContext(notices, "issue-1139-direct-input-reset");
		await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
		await createActiveGoal(harness, ctx, "Reset the unattended budget on direct input");

		await runContinuationTurn(harness, ctx, cleanAssistantStopWithText("varied narration one"));
		await runContinuationTurn(harness, ctx, cleanAssistantStopWithText("varied narration two"));
		expect(harness.sent).toHaveLength(2);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "active",
			unattendedContinuations: 2,
		});

		await runAcceptedDirectInput(harness, ctx, "issue-1139-reset");
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "active",
			unattendedContinuations: 0,
		});
	});

	it("reactivates a backstop-blocked goal on accepted direct input with the budget restored", async () => {
		const notices: string[] = [];
		const harness = createGoalHarness();
		const ctx = await makeGoalContext(notices, "issue-1139-reactivation");
		await createActiveGoal(harness, ctx, "Resume after the unattended backstop");
		await updateGoal(goalStoreRef(ctx), { status: "blocked", reason: UNATTENDED_BLOCKED_REASON }, "model");

		await runAcceptedDirectInput(harness, ctx, "issue-1139-reactivate");

		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "active",
			unattendedContinuations: 0,
		});
	});

	it("does not count monitor-delayed deliveries toward the unattended budget", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const harness = createGoalHarness();
		const ctx = await makeGoalContext(notices, "issue-1139-monitor-exempt");
		await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
		await createActiveGoal(harness, ctx, "Keep watching the monitor");

		// An immediate delivery consumes one unit of the unattended budget.
		const immediateDeliveryRecorded = waitForSentCount(harness, 1);
		await runContinuationTurn(harness, ctx, cleanAssistantStopWithText("immediate continuation"));
		await immediateDeliveryRecorded;
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ unattendedContinuations: 1 });

		// A monitor-delayed delivery (armed wake source, cache-aware timer) does not.
		harness.events.emit("terminal_monitor_state", { activeCount: 1 });
		await harness.events.flush();
		await runContinuationTurn(harness, ctx, cleanAssistantStopWithText("waiting on the monitor"));
		const delayedDeliveryRecorded = waitForSentCount(harness, 2);
		await vi.advanceTimersByTimeAsync(240_000);
		await delayedDeliveryRecorded;

		expect(harness.sent).toHaveLength(2);
		expect(harness.sent[1]?.message.customType).toBe(GOAL_CONTINUATION_MESSAGE_TYPE);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ unattendedContinuations: 1 });
	});
});
