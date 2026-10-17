import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { GOAL_NO_PROGRESS_CONTINUATION_LIMIT } from "../../../src/core/extensions/builtin/goal/continuation.ts";
import { NO_PROGRESS_BLOCKED_REASON } from "../../../src/core/extensions/builtin/goal/continuation-recovery.ts";
import { readGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import {
	isHumanInputMonitorNotification,
	MONITOR_NOTIFICATION_CUSTOM_TYPE,
} from "../../../src/core/extensions/builtin/monitor-state-event.ts";
import type { ExtensionContext, ExtensionToolContext } from "../../../src/core/extensions/types.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	makeGoalContext,
	runGoalHandlers,
} from "../goal-monitor-test-harness.ts";
import { createNotifier, line } from "../terminal-monitor-notify-harness.ts";

afterEach(async () => {
	await cleanupGoalMonitorTempDirs();
});

function goalStoreRef(ctx: ExtensionContext) {
	return {
		baseDir: join(ctx.sessionManager.getSessionDir(), "extensions", "goal"),
		threadId: ctx.sessionManager.getSessionId(),
	};
}

function narration(text: string): AgentMessage {
	const message = cleanAssistantStop();
	if (message.role !== "assistant") throw new Error("Expected an assistant message");
	return { ...message, content: [{ type: "text", text }] };
}

function toolTurn(
	turn: number,
	call: { name: string; arguments: Record<string, string> },
	result: { text: string; isError: boolean },
): AgentMessage[] {
	const final = narration(`step ${turn}: looked at the result again`);
	if (final.role !== "assistant") throw new Error("Expected an assistant message");
	const toolCallId = `omo-10280-tool-${turn}`;
	return [
		{ ...final, content: [{ type: "toolCall", id: toolCallId, ...call }], stopReason: "toolUse" },
		{
			role: "toolResult",
			toolCallId,
			toolName: call.name,
			content: [{ type: "text", text: result.text }],
			isError: result.isError,
			timestamp: final.timestamp,
		},
		final,
	];
}

function editTurn(turn: number): AgentMessage[] {
	return toolTurn(
		turn,
		{ name: "edit", arguments: { path: `src/step-${turn}.ts`, newText: `export const step = ${turn};` } },
		{ text: `Edited src/step-${turn}.ts`, isError: false },
	);
}

function sameFailingTestTurn(turn: number): AgentMessage[] {
	return toolTurn(
		turn,
		{ name: "bash", arguments: { command: "bun test src/parser.test.ts" } },
		{ text: "1 fail: parser rejects empty input", isError: true },
	);
}

function sameStatusPeekTurn(turn: number): AgentMessage[] {
	return toolTurn(
		turn,
		{ name: "bash_output", arguments: { bash_id: "bash_3" } },
		{ text: "(no new output)", isError: false },
	);
}

function monitorNotification(humanInput: boolean): AgentMessage {
	return {
		role: "custom",
		customType: MONITOR_NOTIFICATION_CUSTOM_TYPE,
		content: "<system-reminder>Monitor event(team chat): can you also check the logs?</system-reminder>",
		display: false,
		details: {
			monitors: [
				{
					id: "bash_7",
					description: "team chat",
					eventCount: 1,
					kinds: ["line"],
					...(humanInput ? { humanInput: true } : {}),
				},
			],
		},
		timestamp: 1,
	} as AgentMessage;
}

async function startGoal(threadId: string) {
	const notices: string[] = [];
	const harness = createGoalHarness();
	const ctx = await makeGoalContext(notices, threadId);
	await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
	await harness.tools
		.get("create_goal")
		?.execute("omo-10280-create", { objective: "Keep working" }, undefined, undefined, ctx as ExtensionToolContext);
	const turn = async (messages: AgentMessage[]) => {
		await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(harness.handlers, "agent_end", { type: "agent_end", messages }, ctx);
	};
	return { harness, ctx, notices, turn, ref: goalStoreRef(ctx) };
}

describe("omo#10280: no fixed auto-continue cap, a no-progress guard instead", () => {
	it("never stops a long session that keeps making real edits, well past the old 150 cap", {
		timeout: 120_000,
	}, async () => {
		const { harness, turn, ref } = await startGoal("omo-10280-steady");
		for (let index = 1; index <= 200; index++) await turn(editTurn(index));

		expect(harness.sent).toHaveLength(200);
		expect(await readGoal(ref)).toMatchObject({ status: "active", noProgressContinuations: 1 });
		expect(harness.events.emitted).not.toContainEqual(
			expect.objectContaining({ channel: "goal_continuation_guard_tripped" }),
		);
	});

	it("stops a varied-narration loop with no tool use at the guard, with a reason and a next step", {
		timeout: 60_000,
	}, async () => {
		const { harness, turn, ref, notices } = await startGoal("omo-10280-stall");
		for (let index = 1; index <= GOAL_NO_PROGRESS_CONTINUATION_LIMIT + 1; index++) {
			await turn([narration(`still thinking about it, take ${index}`)]);
		}

		expect(harness.sent).toHaveLength(GOAL_NO_PROGRESS_CONTINUATION_LIMIT);
		expect(await readGoal(ref)).toMatchObject({ status: "blocked", blockedReason: NO_PROGRESS_BLOCKED_REASON });
		expect(notices).toContainEqual(
			`Goal continuation blocked: ${NO_PROGRESS_BLOCKED_REASON}. Send any message to resume.`,
		);
		expect(harness.events.emitted).toContainEqual(
			expect.objectContaining({
				channel: "goal_continuation_guard_tripped",
				data: expect.objectContaining({ reason: "no-progress" }),
			}),
		);
	});

	it.each([
		["re-runs the same failing test", sameFailingTestTurn],
		["peeks the same unchanged output", sameStatusPeekTurn],
	] as const)(
		"stops a loop that %s with varied narration at the guard",
		{ timeout: 60_000 },
		async (_label, loopTurn) => {
			const { harness, turn, ref, notices } = await startGoal(`omo-10280-tool-loop-${_label.length}`);
			for (let index = 1; index <= GOAL_NO_PROGRESS_CONTINUATION_LIMIT + 1; index++) await turn(loopTurn(index));

			expect(harness.sent).toHaveLength(GOAL_NO_PROGRESS_CONTINUATION_LIMIT);
			expect(await readGoal(ref)).toMatchObject({ status: "blocked", blockedReason: NO_PROGRESS_BLOCKED_REASON });
			expect(notices).toContainEqual(
				`Goal continuation blocked: ${NO_PROGRESS_BLOCKED_REASON}. Send any message to resume.`,
			);
		},
	);

	it("counts an edit between failing runs as progress, so a real fix-and-retest cycle never stops", {
		timeout: 60_000,
	}, async () => {
		const { harness, turn, ref } = await startGoal("omo-10280-fix-retest");
		const cycles = GOAL_NO_PROGRESS_CONTINUATION_LIMIT;
		for (let index = 1; index <= cycles; index++) {
			await turn(sameFailingTestTurn(index));
			await turn(editTurn(index));
		}

		expect(harness.sent).toHaveLength(2 * cycles);
		expect(await readGoal(ref)).toMatchObject({ status: "active" });
	});

	it("resets the guard when a monitor delivery of a person's message wakes the idle goal session", {
		timeout: 60_000,
	}, async () => {
		const { harness, turn, ref } = await startGoal("omo-10280-human-monitor");
		for (let index = 1; index < GOAL_NO_PROGRESS_CONTINUATION_LIMIT; index++)
			await turn([narration(`waiting ${index}`)]);
		expect(await readGoal(ref)).toMatchObject({ noProgressContinuations: GOAL_NO_PROGRESS_CONTINUATION_LIMIT - 1 });

		await turn([monitorNotification(true), narration("on it, checking the logs")]);
		expect(await readGoal(ref)).toMatchObject({
			status: "active",
			noProgressContinuations: 1,
			unattendedContinuations: 1,
		});

		for (let index = 1; index < GOAL_NO_PROGRESS_CONTINUATION_LIMIT; index++)
			await turn([narration(`after ${index}`)]);
		expect(await readGoal(ref)).toMatchObject({ status: "active" });
		expect(harness.sent).toHaveLength(2 * GOAL_NO_PROGRESS_CONTINUATION_LIMIT - 1);
	});

	it("does not reset the guard for a machine-status monitor event", { timeout: 60_000 }, async () => {
		const { turn, ref } = await startGoal("omo-10280-machine-monitor");
		for (let index = 1; index < GOAL_NO_PROGRESS_CONTINUATION_LIMIT; index++)
			await turn([narration(`waiting ${index}`)]);

		await turn([monitorNotification(false), narration("build is still running")]);
		expect(await readGoal(ref)).toMatchObject({
			status: "active",
			noProgressContinuations: GOAL_NO_PROGRESS_CONTINUATION_LIMIT,
		});

		await turn([narration("still waiting on the build")]);
		expect(await readGoal(ref)).toMatchObject({ status: "blocked", blockedReason: NO_PROGRESS_BLOCKED_REASON });
	});

	it("marks only human-input monitor lines as human input in the delivered notification", () => {
		const { notifier, scheduler, sent } = createNotifier();
		notifier.notifyEvent({
			type: "line",
			id: "bash_7",
			description: "team chat",
			line: "can you also check the logs?",
			humanInput: true,
		});
		notifier.notifyEvent(line("bash_8", "ci", "build 41 passed"));
		scheduler.advanceBy(2000);

		expect(sent).toHaveLength(1);
		const delivered = { role: "custom", ...sent[0]?.message };
		expect(delivered).toMatchObject({
			customType: MONITOR_NOTIFICATION_CUSTOM_TYPE,
			details: {
				monitors: [
					expect.objectContaining({ id: "bash_7", humanInput: true }),
					expect.not.objectContaining({ humanInput: true }),
				],
			},
		});
		expect(isHumanInputMonitorNotification(delivered)).toBe(true);

		notifier.notifyEvent(line("bash_8", "ci", "build 42 passed"));
		scheduler.advanceBy(6000);
		expect(isHumanInputMonitorNotification({ role: "custom", ...sent[1]?.message })).toBe(false);
	});
});
