import { expect, it } from "vitest";
import type { TurnEndLivenessInput } from "../../../src/core/extensions/builtin/goal/turn-end-liveness.ts";
import type { Goal } from "../../../src/core/extensions/builtin/goal/types.ts";
import type { LifecycleRecord } from "../../../src/core/lifecycle-record.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";

// senpi#3864 (lifecycle addendum item 2): `lastStop` explains why the last run stopped, from the facts the stopping
// run itself produced: a goal guard as recorded, the todo backstop's returned outcome, the classified abort, or an
// unowned continuation. Provider errors keep the failed path and carry no stop.
function input(patch: Partial<TurnEndLivenessInput>): TurnEndLivenessInput {
	return {
		isChildSession: false,
		mode: "rpc",
		ledgerHold: undefined,
		endedBy: "clean",
		willRetry: false,
		deadlineStop: false,
		goalStopped: false,
		openWork: { kind: "none" },
		continuationQueued: undefined,
		expectations: [],
		budgetSpent: false,
		providerRetryAtMs: undefined,
		...patch,
	};
}

function goal(patch: Partial<Goal>): Goal {
	return {
		id: "goal-1",
		threadId: "thread",
		objective: "Ship it",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
		...patch,
	};
}

async function controllerOn(manager: SessionManager) {
	const { SessionLifecycleController } = await import("../../../src/core/session-lifecycle.ts");
	const controller = new SessionLifecycleController({
		sessionId: manager.getSessionId(),
		entries: manager.getEntries(),
		append: (record) => {
			manager.appendCustomEntry("session-lifecycle", record);
		},
		appendChild: (record) => {
			manager.appendCustomEntry("child-lifecycle", record);
		},
		appendCustody: (record) => {
			manager.appendCustomEntry("work-custody", record);
		},
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
	controller.restoreComplete();
	return controller;
}

function records(manager: SessionManager): LifecycleRecord[] {
	return manager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "session-lifecycle")
		.map((entry) => (entry as { data: LifecycleRecord }).data);
}

async function startedRun() {
	const manager = SessionManager.inMemory();
	const controller = await controllerOn(manager);
	controller.startRun();
	const runId = records(manager).at(-1)?.runId;
	if (!runId) throw new Error("the run's opening record carries no runId");
	return { manager, controller, runId };
}

it("names an exhausted todo chain from the returned outcome, once, through restore, until the next run", async () => {
	// Given a root with open todos and no goal whose reminder chain is exhausted on this run.
	const { manager, controller, runId } = await startedRun();
	const capped = input({ openWork: { kind: "open-todos", count: 2 }, budgetSpent: true });
	controller.goalFacts(null, capped, { runId, todo: "capped" });
	controller.idle();
	expect(controller.snapshot).toMatchObject({
		state: "waiting_human",
		waitingOn: { human: [expect.objectContaining({ kind: "stalled" })] },
		lastStop: { cause: "todo_guard", todo: "cap", runId, epoch: 1 },
	});
	const first = controller.snapshot.lastStop;
	const written = records(manager).length;

	// When the same run is observed again, now with the backstop's repeated `cap` outcome.
	controller.goalFacts(null, capped, { runId, todo: "cap" });
	controller.goalFacts(null, capped, { runId, todo: "cap" });

	// Then nothing is rewritten and the stop keeps its first time.
	expect(records(manager)).toHaveLength(written);
	expect(controller.snapshot.lastStop).toEqual(first);

	// And a reload restores it for that run, and the next run clears it.
	const restored = await controllerOn(manager);
	expect(restored.snapshot.lastStop).toEqual(first);
	restored.startRun("automatic");
	expect(restored.snapshot.lastStop).toBeUndefined();
	expect(records(manager).at(-1)?.lastStop).toBeUndefined();
});

it.each([
	{ reason: "cap", stopped: goal({ status: "blocked" }), wait: "goal_blocked" },
	{ reason: "stale", stopped: goal({ continuationStoppedAt: 1 }), wait: "goal_paused" },
	{ reason: "context-overflow", stopped: goal({ status: "blocked" }), wait: "goal_blocked" },
])("names a goal guard $reason exactly as recorded", async ({ reason, stopped, wait }) => {
	// Given a run whose goal continuation a guard refused.
	const { controller, runId } = await startedRun();
	const at = Date.UTC(2026, 9, 25, 3, 0, 0);

	// When its turn-end facts arrive with the recorded guard stop.
	controller.goalFacts(
		stopped,
		input({ budgetSpent: stopped.status === "active", goalStopped: stopped.status !== "active" }),
		{
			runId,
			guard: { reason, at },
		},
	);
	controller.idle();

	// Then the goal wait is unchanged and the stop carries the guard's own reason and time.
	expect(controller.snapshot.waitingOn?.human).toContainEqual(expect.objectContaining({ kind: wait }));
	expect(controller.snapshot.lastStop).toEqual({
		cause: "goal_guard",
		guard: reason,
		runId,
		at: new Date(at).toISOString(),
		epoch: 1,
	});
});

it("sets nothing when a run's turn end arrives after the next run started", async () => {
	// Given run A, whose queued turn end has not been processed when the core drains queued input into run B.
	const { manager, controller, runId: runA } = await startedRun();
	controller.startRun("automatic");
	const runB = records(manager).at(-1)?.runId;
	expect(runB).not.toBe(runA);

	// When A's own end arrives, bound to A at its emission, with an exhausted todo chain.
	controller.goalFacts(null, input({ openWork: { kind: "open-todos", count: 1 }, budgetSpent: true }), {
		runId: runA,
		todo: "capped",
	});

	// Then neither the live snapshot nor any record of B carries A's stop.
	expect(controller.snapshot.lastStop).toBeUndefined();
	for (const record of records(manager).filter((entry) => entry.runId === runB))
		expect(record.lastStop).toBeUndefined();
});

it("sets nothing from a fact refresh that carries no bound turn end", async () => {
	// Given a running run and a refresh whose goal collector still returns the previous run's aborted end.
	const { manager, controller, runId } = await startedRun();

	// When the refresh arrives with no bound turn end (a wake, timer, goal-store or idle refresh).
	controller.goalFacts(null, input({ endedBy: "unknown-abort" }));
	controller.idle();

	// Then it sets no stop on the current run.
	expect(controller.snapshot.lastStop).toBeUndefined();
	for (const record of records(manager).filter((entry) => entry.runId === runId))
		expect(record.lastStop).toBeUndefined();
});

it.each([
	{ endedBy: "system-abort", abortSource: "system" },
	{ endedBy: "provider-abort", abortSource: "provider" },
	{ endedBy: "user-abort", abortSource: "user" },
	{ endedBy: "unknown-abort", abortSource: undefined },
] as const)("names a $endedBy end as an abort with its source", async ({ endedBy, abortSource }) => {
	const { controller, runId } = await startedRun();
	controller.goalFacts(null, input({ endedBy }), { runId });
	controller.idle();
	expect(controller.snapshot.lastStop).toMatchObject({ cause: "aborted", runId, epoch: 1 });
	expect(controller.snapshot.lastStop?.abortSource).toBe(abortSource);
});

it("names an open-work end nothing will continue as no_wake", async () => {
	const { controller, runId } = await startedRun();
	controller.goalFacts(null, input({ openWork: { kind: "open-todos", count: 1 } }), { runId });
	controller.idle();
	expect(controller.snapshot.state).toBe("waiting_human");
	expect(controller.snapshot.lastStop).toMatchObject({ cause: "no_wake", runId });
});

it.each(["provider-error", "policy-rejection"] as const)(
	"keeps a %s on the failed path with no stop",
	async (endedBy) => {
		const { controller, runId } = await startedRun();
		controller.deadlineStopped("inactivity", Date.UTC(2026, 9, 25));
		controller.goalFacts(null, input({ endedBy }), { runId });
		controller.idle();
		expect(controller.snapshot).toMatchObject({ state: "failed", failure: { reason: "provider_error" } });
		expect(controller.snapshot.lastStop).toBeUndefined();
	},
);

it("keeps a deadline stop while live child work keeps the session waiting", async () => {
	// Given a run that a max_runtime deadline stops while a child task still runs.
	const { controller, runId } = await startedRun();
	controller.obligations.syncSource("senpi-task", "children", 1);
	const at = Date.UTC(2026, 9, 25, 4, 0, 0);
	controller.deadlineStopped("max_runtime", at);

	// When its turn end arrives.
	controller.goalFacts(null, input({ endedBy: "system-abort", deadlineStop: true }), { runId });
	controller.idle();

	// Then the state still names the child, and the stop names the deadline that ended this run.
	expect(controller.snapshot.state).toBe("waiting_children");
	expect(controller.snapshot.lastStop).toEqual({
		cause: "deadline",
		deadline: "max_runtime",
		runId,
		at: new Date(at).toISOString(),
		epoch: 1,
	});
});

it.each([
	{ name: "a legacy record", lastStop: undefined },
	{ name: "a malformed stop", lastStop: { cause: "budget", runId: "run-1", at: 7, epoch: "one" } },
	{
		name: "a stop recorded for another run",
		lastStop: { cause: "aborted", runId: "run-0", at: "2026-10-25T00:00:00.000Z", epoch: 1 },
	},
])("restores $name with its base record and no stop", async ({ lastStop }) => {
	// Given a durable record whose optional stop detail is absent, malformed, or for a run it does not name.
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry("session-lifecycle", {
		sessionId: manager.getSessionId(),
		state: "waiting_human",
		seq: 4,
		epoch: 1,
		epochOrigin: "human",
		humanInputRevision: 1,
		selfSettleEligible: true,
		runPaused: false,
		since: "2026-10-25T00:00:00.000Z",
		role: "root",
		rootSessionId: manager.getSessionId(),
		persisted: true,
		runId: "run-1",
		runActive: false,
		...(lastStop ? { lastStop } : {}),
	});

	// When the session reopens.
	const restored = await controllerOn(manager);

	// Then the valid base restores, and no cause is fabricated for it.
	expect(restored.snapshot).toMatchObject({ epoch: 1, humanInputRevision: 1 });
	expect(restored.snapshot.lastStop).toBeUndefined();
});
