// senpi#3864 (review r4 finding 1, review r5 findings 1-2): a turn end is bound to its run when its agent_end is
// emitted. The agent core can drain queued input into run B before the session's event queue reaches run A's
// agent_end, so A's late end, and any fact refresh before it, must not label or show a stop on B. B's own end is a
// repeated todo cap (the reminder chain is per session) and names B.
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import { admitAndQueueGoalContinuation } from "../../../src/core/extensions/builtin/goal/lifecycle-helpers.ts";
import { createGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../../src/core/extensions/builtin/goal/store-ref.ts";
import {
	TODO_OWED_REMINDER_EVENT,
	type TodoOwedReminderEvent,
} from "../../../src/core/extensions/builtin/goal/todo-owed-backstop.ts";
import todotoolsExtension from "../../../src/core/extensions/builtin/todotools/index.ts";
import type { LifecycleRecord } from "../../../src/core/lifecycle-record.ts";
import type { LifecycleSessionBinding } from "../../../src/core/lifecycle-session-binding.ts";
import type { SessionLifecycle } from "../../../src/core/session-lifecycle-types.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`no signal within ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function lifecycleRecords(harness: Harness): LifecycleRecord[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "session-lifecycle")
		.map((entry) => (entry as { data: LifecycleRecord }).data);
}

it("keeps a run's late todo cap off the run the core drained before that end was processed", async () => {
	// Given a root with open todos, no goal and no on-duty source, whose reminder chain is spent by run A (the third
	// run), and no agent_before_settle handler, so queued input is drained by the core itself.
	const reminders: TodoOwedReminderEvent[] = [];
	const coreStartsAtEnd: number[] = [];
	let coreStarts = 0;
	let bEndEmittedAt = 0;
	let recordsBeforeBEnd = 0;
	let stopBeforeBEnd: SessionLifecycle["lastStop"] | "not-observed" = "not-observed";
	let refreshed: (() => void) | undefined;
	let stopAtLateRefresh: SessionLifecycle["lastStop"] | "not-observed" = "not-observed";
	const h = await createHarness({
		extensionFactories: [
			todotoolsExtension,
			goalExtension,
			(pi) => {
				pi.events.on(TODO_OWED_REMINDER_EVENT, (data) => reminders.push(data as TodoOwedReminderEvent));
				pi.on("agent_end", async () => {
					coreStartsAtEnd.push(coreStarts);
					if (coreStarts !== 4 || coreStartsAtEnd.length !== 3) return;
					// Inside A's late end, after the goal extension recorded A's end and outcome and before A's
					// turnEnded (and before the goal extension sees B's agent_start), a wake refresh lands during B.
					const landed = new Promise<void>((resolve) => {
						refreshed = resolve;
					});
					pi.events.emit("wake_source_state", { source: "test-monitor", activeCount: 0 });
					await within(landed, 5000);
					stopAtLateRefresh = h.session.lifecycle.lastStop;
				});
			},
		],
		fileSettings: true,
		settings: { todo: { firstTurnPlan: "off" } },
	});
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc" });
	const binding = (h.session as unknown as { _lifecycleBinding: LifecycleSessionBinding })._lifecycleBinding;
	const goalFacts = binding.controller.goalFacts.bind(binding.controller);
	vi.spyOn(binding.controller, "goalFacts").mockImplementation((goal, input, stop) => {
		goalFacts(goal, input, stop);
		if (stop === undefined) refreshed?.();
	});
	// An extension follow-up lands in the agent queue at A's agent_end emission, after the loop's last poll.
	const session = h.session;
	session.agent.subscribe((event) => {
		if (event.type === "agent_start") coreStarts += 1;
		if (event.type === "agent_end" && coreStarts === 4) {
			// B's own end is emitted but not yet processed: everything up to here was written while B ran.
			bEndEmittedAt = Date.now();
			recordsBeforeBEnd = lifecycleRecords(h).length;
			stopBeforeBEnd = session.lifecycle.lastStop;
		}
		if (event.type !== "agent_end" || coreStarts !== 3) return;
		session.agent.followUp({
			role: "custom",
			customType: "test-follow-up",
			content: [{ type: "text", text: "A watched job finished." }],
			display: false,
			timestamp: Date.now(),
		});
	});
	h.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("todo", { op: "init", list: [{ phase: "Build", items: ["Write the parser", "Wire it"] }] })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Working on the parser."),
		fauxAssistantMessage("Still on the parser."),
		fauxAssistantMessage("Pausing the parser here."),
		fauxAssistantMessage("Noted the watched job; the parser is still paused."),
	]);

	// When run A ends and the core drains the follow-up as run B before A's queued end is processed.
	await h.session.prompt("Write and wire the parser.");
	await h.session.waitForSettledSessionWork();

	// Then A's end really was processed after B started, and A's own end capped the todo chain.
	expect(coreStarts).toBe(4);
	expect(coreStartsAtEnd[2]).toBe(4);
	expect(reminders.map((event) => event.reason)).toEqual(["delivered", "delivered", "capped"]);

	// And the wake refresh inside A's late end set nothing on B.
	expect(stopAtLateRefresh).toBeUndefined();

	// And no record of B carries a stop while B runs, and A never gets one from its late end.
	const runIds = [...new Set(lifecycleRecords(h).map((record) => record.runId))];
	const [runA, runB] = runIds.slice(-2);
	expect(runIds).toHaveLength(4);
	const runningB = lifecycleRecords(h)
		.slice(0, recordsBeforeBEnd)
		.filter((record) => record.runId === runB);
	expect(runningB.some((record) => record.state === "running" && record.runActive)).toBe(true);
	for (const record of runningB) expect(record.lastStop).toBeUndefined();
	expect(stopBeforeBEnd).toBeUndefined();
	for (const record of lifecycleRecords(h)) expect(record.lastStop?.runId).not.toBe(runA);

	// And after B ends, B's own repeated cap names B, with the time of B's own end.
	const stopB = h.session.lifecycle.lastStop;
	expect(stopB).toMatchObject({ cause: "todo_guard", todo: "cap", runId: runB, epoch: 1 });
	expect(Date.parse(stopB?.at ?? "")).toBeGreaterThanOrEqual(bEndEmittedAt);

	// And a reload after B restores B's stop exactly.
	const { SessionLifecycleController } = await import("../../../src/core/session-lifecycle.ts");
	const reloaded = new SessionLifecycleController({
		sessionId: h.sessionManager.getSessionId(),
		entries: h.sessionManager.getEntries(),
		append: () => {},
		appendChild: () => {},
		appendCustody: () => {},
		emit: () => {},
		readRuntime: () => ({
			activity: {
				isStreaming: false,
				isBashRunning: false,
				isCompacting: false,
				hasSessionWork: false,
				hasActiveWakeSource: false,
			},
			pendingMessages: 0,
			human: [],
			holds: [],
		}),
	});
	reloaded.restoreComplete();
	expect(reloaded.snapshot.lastStop).toEqual(stopB);
});

it.each([
	{ drain: false, aborted: false },
	{ drain: true, aborted: false },
	{ drain: true, aborted: true },
])("keeps A's goal guard on its own end with drain=$drain and B aborted=$aborted", async ({ drain, aborted }) => {
	// senpi#3864 review r1: the goal handler appends A's guard after B's run-start leaf.
	let coreStarts = 0;
	let processedEnds = 0;
	let startsAtAEnd = 0;
	const h = await createHarness({
		settings: { retry: { enabled: false } },
		extensionFactories: [
			(pi) => {
				pi.on("agent_end", async (_event, ctx) => {
					if (++processedEnds !== 1) return;
					const ref = goalStoreRef(ctx.sessionManager, ctx.cwd);
					const goal = await createGoal(ref, "Finish the parser");
					// Admission facts describe A's completed turn, not B's live streaming state.
					await admitAndQueueGoalContinuation(pi, ctx, goal, {
						input: {
							isIdle: true,
							hasPendingMessages: false,
							path: "immediate",
							lastStopReason: "stop",
							lastTurnWasMalformedToolUse: false,
							consecutiveContinuations: 8,
							lastContinuationSignature: undefined,
							currentSignature: "A",
							consecutiveLengthRecoveries: 0,
							recentNormalizedOutputHashes: [],
							toollessContinuationStreak: 0,
							continuationPending: false,
							lastTurnStuckOnContextOverflow: false,
						},
						content: () => "Continue",
						markContinuationPending: () => {},
					});
					startsAtAEnd = coreStarts;
				});
			},
			goalExtension,
		],
	});
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc" });
	h.session.agent.subscribe((event) => {
		if (event.type === "agent_start") coreStarts++;
		if (event.type !== "agent_end" || coreStarts !== 1 || !drain) return;
		h.session.agent.followUp({
			role: "custom",
			customType: "test-follow-up",
			content: [{ type: "text", text: "A watched job finished." }],
			display: false,
			timestamp: Date.now(),
		});
	});
	h.setResponses([
		fauxAssistantMessage("Pausing the parser."),
		{
			...fauxAssistantMessage("Noted the watched job.", { stopReason: aborted ? "aborted" : "stop" }),
			...(aborted ? { abortSource: "provider" as const } : {}),
		},
	]);
	await h.session.prompt("Work on the parser.");
	await h.session.waitForSettledSessionWork();

	expect(coreStarts).toBe(drain ? 2 : 1);
	expect(startsAtAEnd).toBe(drain ? 2 : 1);
	const guards = h.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom" && entry.customType === "goal-continuation-stopped");
	expect(guards).toHaveLength(1);
	expect(guards[0]).toMatchObject({ data: { reason: "cap" } });
	const records = lifecycleRecords(h);
	const [runA, runB] = [...new Set(records.map((record) => record.runId))];
	if (!drain) {
		expect(h.session.lifecycle.lastStop).toMatchObject({ cause: "goal_guard", guard: "cap", runId: runA });
		return;
	}
	// A's late end cannot publish a stop once B is current. B must never inherit A's guard, including on refresh.
	for (const record of records) {
		expect(record.lastStop?.runId).not.toBe(runA);
		if (record.runId === runB) expect(record.lastStop?.cause).not.toBe("goal_guard");
	}
	if (aborted)
		expect(h.session.lifecycle.lastStop).toMatchObject({ cause: "aborted", abortSource: "provider", runId: runB });
	else expect(h.session.lifecycle.lastStop?.cause).not.toBe("goal_guard");
});
