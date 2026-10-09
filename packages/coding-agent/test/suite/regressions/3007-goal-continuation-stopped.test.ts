import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerGoalCommand } from "../../../src/core/extensions/builtin/goal/command-registration.ts";
import type { GoalContinuationInput } from "../../../src/core/extensions/builtin/goal/continuation.ts";
import { goalLiveElapsedSeconds } from "../../../src/core/extensions/builtin/goal/elapsed-ticker.ts";
import {
	admitAndQueueGoalContinuation,
	queueGoalContinuation,
} from "../../../src/core/extensions/builtin/goal/lifecycle-helpers.ts";
import {
	accountGoalUsage,
	createGoal,
	readGoal,
	recordContinuationDelivered,
	writeGoal,
} from "../../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../../src/core/extensions/builtin/goal/store-ref.ts";
import type { Goal } from "../../../src/core/extensions/builtin/goal/types.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../../../src/core/extensions/types.ts";
import {
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	makeGoalContext,
	runGoalHandlers,
} from "../goal-monitor-test-harness.ts";

afterEach(async () => {
	vi.restoreAllMocks();
	await cleanupGoalMonitorTempDirs();
});

async function fixture() {
	const harness = createGoalHarness();
	const ctx = await makeGoalContext([], "goal-stopped-3007");
	const ref = goalStoreRef(ctx.sessionManager, ctx.cwd);
	const goal = await createGoal(ref, "Implement the stop signal");
	await writeGoal(ref, {
		...goal,
		lastStartedAt: 100,
		timeUsedSeconds: 7,
		consecutiveContinuations: 2,
		unattendedContinuations: 4,
		lastContinuationSignature: "same",
	});
	const active = await readGoal(ref);
	if (!active) throw new Error("expected goal");
	const pi = {
		appendEntry: (customType: string, data: unknown) => harness.entries.push({ customType, data }),
		events: harness.events,
		sendMessage: harness.sendMessage,
	} as unknown as ExtensionAPI;
	const input: Omit<GoalContinuationInput, "goal"> = {
		isIdle: true,
		hasPendingMessages: false,
		path: "immediate",
		lastStopReason: "stop",
		lastTurnWasMalformedToolUse: false,
		consecutiveContinuations: 2,
		lastContinuationSignature: "same",
		currentSignature: "same",
		consecutiveLengthRecoveries: 0,
		recentNormalizedOutputHashes: [],
		toollessContinuationStreak: 0,
		continuationPending: false,
		lastTurnStuckOnContextOverflow: false,
	};
	const deny = (candidate: Goal = active, overrides: Partial<typeof input> = {}) =>
		admitAndQueueGoalContinuation(pi, ctx, candidate, {
			input: { ...input, ...overrides },
			content: () => "continue",
			markContinuationPending: () => {},
		});
	return { harness, ctx, ref, active, input, pi, deny };
}

describe("senpi#3007 goal stop decisions", () => {
	it("records stale once, closes elapsed accounting, and ignores eligibility and single-flight probes", async () => {
		vi.spyOn(Date, "now").mockReturnValue(110_000);
		const f = await fixture();
		await f.deny(f.active, { hasPendingMessages: true });
		await f.deny(f.active, { continuationPending: true });
		expect(f.harness.entries).toEqual([]);
		const stopped = await f.deny();
		await f.deny();
		expect(f.harness.entries).toEqual([
			{
				customType: "goal-continuation-stopped",
				data: {
					goalId: f.active.id,
					reason: "stale",
					consecutiveContinuations: 2,
					unattendedContinuations: 4,
					at: 110_000,
				},
			},
			{
				customType: "engine-paused",
				data: { reason: "goal-stale", customType: "goal-continuation", count: 2, at: 110_000 },
			},
		]);
		expect(stopped).toMatchObject({ status: "active", timeUsedSeconds: 17 });
		expect(stopped?.lastStartedAt).toBeUndefined();
		if (!stopped) throw new Error("expected stopped goal");
		await queueGoalContinuation(f.pi, f.ctx, stopped, {
			continuationPending: false,
			markContinuationPending: () => {},
		});
		expect(f.harness.sent).toEqual([]);
		expect(goalLiveElapsedSeconds(stopped, 110_000, 900_000)).toBe(17);
		expect(await readGoal(f.ref)).toEqual(stopped);
	});

	it.each([
		["cap", { consecutiveContinuations: 8 }],
		["unattended", {}],
		["repetition", { recentNormalizedOutputHashes: ["a", "a", "a"] }],
		["length-exhausted", { currentSignature: "new", lastStopReason: "length", consecutiveLengthRecoveries: 1 }],
		["context-overflow", { lastTurnStuckOnContextOverflow: true }],
	] as const)("records the %s guard once even when the same active snapshot is retried", async (reason, overrides) => {
		const f = await fixture();
		const candidate = reason === "unattended" ? { ...f.active, unattendedContinuations: 150 } : f.active;
		await writeGoal(f.ref, candidate);
		await f.deny(candidate, overrides);
		await f.deny(candidate, overrides);
		expect(f.harness.entries.filter((entry) => entry.customType === "goal-continuation-stopped")).toEqual([
			{
				customType: "goal-continuation-stopped",
				data: {
					goalId: candidate.id,
					reason,
					consecutiveContinuations: reason === "cap" ? 8 : 2,
					unattendedContinuations: candidate.unattendedContinuations,
					at: expect.any(Number),
				},
			},
		]);
		expect((await readGoal(f.ref))?.status).toBe("blocked");
		if (reason === "repetition") {
			expect(f.harness.entries.filter((entry) => entry.customType === "engine-paused")).toEqual([
				{
					customType: "engine-paused",
					data: { reason: "goal-repeat", customType: "goal-continuation", count: 2, at: expect.any(Number) },
				},
			]);
		}
	});

	it.each(["input", "resume"] as const)(
		"reopens the window and permits another stale stop after %s",
		async (reset) => {
			const f = await fixture();
			await f.deny();
			if (reset === "input") {
				await runGoalHandlers(
					f.harness.handlers,
					"input",
					{ inputId: "u1", source: "rpc", text: "continue" },
					f.ctx,
				);
				await runGoalHandlers(
					f.harness.handlers,
					"input_disposition",
					{ inputId: "u1", disposition: "started" },
					f.ctx,
				);
			} else {
				let resume: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
				registerGoalCommand(
					{
						...f.pi,
						registerCommand: (_name, command) => {
							resume = command.handler;
						},
					},
					{
						goalStoreRef: () => f.ref,
						accountCurrentAgentTurn: () => readGoal(f.ref),
						beginAgentGoalAccounting: () => {},
						stopAgentGoalAccounting: () => {},
						clearAgentGoalAccounting: () => {},
						queueGoalContinuation: () => {},
						refreshGoalUi: () => {},
					},
				);
				if (!resume) throw new Error("expected resume command");
				await resume("resume", f.ctx as ExtensionCommandContext);
			}
			const resumed = await readGoal(f.ref);
			expect(resumed).toMatchObject({ consecutiveContinuations: 0, unattendedContinuations: 0 });
			expect(resumed?.lastContinuationSignature).toBeUndefined();
			expect(resumed?.lastStartedAt).toEqual(expect.any(Number));
			const delivered = await recordContinuationDelivered(f.ref, "same", f.active.id);
			if (!delivered) throw new Error("expected continuation");
			await f.deny(delivered, { consecutiveContinuations: 1 });
			expect(f.harness.entries.filter((entry) => entry.customType === "goal-continuation-stopped")).toHaveLength(2);
			await runGoalHandlers(f.harness.handlers, "session_shutdown", {}, f.ctx);
		},
	);

	it("closes only the uncommitted tail after a usage checkpoint", async () => {
		vi.spyOn(Date, "now").mockReturnValue(110_000);
		const f = await fixture();
		await accountGoalUsage(f.ref, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 }, 10);
		vi.spyOn(Date, "now").mockReturnValue(115_900);
		await f.deny();
		expect(await readGoal(f.ref)).toMatchObject({ timeUsedSeconds: 22, tokensUsed: 3 });
	});

	it("stops live footer accounting after actual agent-end stale admission", async () => {
		const f = await fixture();
		const message: AgentMessage = {
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
			stopReason: "stop",
			timestamp: Date.now(),
		};
		await writeGoal(f.ref, { ...f.active, lastContinuationSignature: `${f.active.id}:0/0:811c9dc5` });
		await runGoalHandlers(f.harness.handlers, "agent_start", {}, f.ctx);
		await runGoalHandlers(f.harness.handlers, "agent_end", { messages: [message] }, f.ctx);
		const stopped = await readGoal(f.ref);
		expect(stopped?.lastStartedAt).toBeUndefined();
		expect(f.harness.entries.filter((entry) => entry.customType === "goal-continuation-stopped")).toHaveLength(1);
		await runGoalHandlers(f.harness.handlers, "session_shutdown", {}, f.ctx);
		expect((await readGoal(f.ref))?.timeUsedSeconds).toBe(stopped?.timeUsedSeconds);
	});
});
