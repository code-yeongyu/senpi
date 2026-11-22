import { expect, it } from "vitest";
import type { TurnEndLivenessInput } from "../../../src/core/extensions/builtin/goal/turn-end-liveness.ts";
import type { LifecycleHold, SessionLifecycleEvent } from "../../../src/core/session-lifecycle-types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";

// senpi#3864: the mapping consumes #3865 facts, never a continuation verdict label.
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
async function subject(child = false) {
	const { SessionLifecycleController } = await import("../../../src/core/session-lifecycle.ts");
	const manager = SessionManager.inMemory();
	const events: SessionLifecycleEvent[] = [];
	const holds: LifecycleHold[] = [];
	const controller = new SessionLifecycleController({
		sessionId: manager.getSessionId(),
		entries: manager.getEntries(),
		...(child ? { spawnedBy: { parentSessionId: "parent", rootSessionId: "root", taskId: "task" } } : {}),
		append: (record) => {
			manager.appendCustomEntry("session-lifecycle", record);
		},
		appendChild: (record) => {
			manager.appendCustomEntry("child-lifecycle", record);
		},
		appendCustody: (record) => {
			manager.appendCustomEntry("work-custody", record);
		},
		emit: (event) => {
			events.push(event);
		},
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
			holds,
		}),
	});
	controller.restoreComplete();
	controller.startRun();
	return { controller, events, holds, sessionId: manager.getSessionId() };
}

for (const timer of ["monitor", "providerRetry", "userGrace"] as const) {
	it(`maps an armed ${timer} timer to its specified lifecycle row`, async () => {
		const { controller } = await subject();
		const retryAtMs = Date.now() + 60_000;
		controller.goalFacts(
			null,
			input({
				endedBy: timer === "providerRetry" ? "provider-error" : "clean",
				expectations: [{ kind: "armed-timer", timer }],
				providerRetryAtMs: retryAtMs,
			}),
		);
		controller.idle();
		expect(controller.snapshot.state).toBe(timer === "userGrace" ? "running" : "waiting_background");
		if (timer === "providerRetry")
			expect(controller.snapshot.waitingOn?.background).toContainEqual({
				source: "provider-retry",
				activeCount: 1,
				retryAtMs,
			});
	});
}

for (const endedBy of ["unknown-abort", "system-abort", "provider-abort"] as const) {
	it(`keeps ${endedBy} waiting for a person, never a completion`, async () => {
		const { controller, events } = await subject();
		controller.goalFacts(null, input({ endedBy }));
		controller.idle();
		expect(controller.snapshot).toMatchObject({
			state: "waiting_human",
			waitingOn: {
				human: [expect.objectContaining({ kind: "stalled" })],
			},
		});
		expect(events.some((event) => event.lifecycle.state === "done")).toBe(false);
	});
}

it("gives two stalls in the same epoch different occurrence identities", async () => {
	const { controller } = await subject();
	const stalled = input({ budgetSpent: true, openWork: { kind: "open-todos", count: 1 } });
	controller.goalFacts(null, stalled);
	const first = controller.snapshot.waitingOn?.human[0]?.requestId;
	controller.goalFacts(null, input({ continuationQueued: "todo-backstop" }));
	expect(controller.snapshot.waitingOn?.human).toEqual([]);
	controller.goalFacts(null, stalled);
	expect(controller.snapshot.waitingOn?.human[0]?.requestId).not.toBe(first);
	expect(controller.snapshot.epoch).toBe(1);
});

it("ignores heldBy-style stop explanations when an independent child wake still owns work", async () => {
	const { controller } = await subject();
	controller.obligations.syncSource("senpi-task", "children", 1);
	controller.goalFacts(
		null,
		input({
			endedBy: "user-abort",
			goalStopped: true,
			expectations: [
				{ kind: "wake-source", source: "senpi-task" },
				{ kind: "armed-timer", timer: "monitor" },
			],
		}),
	);
	controller.idle();
	expect(controller.snapshot.state).toBe("waiting_children");
});

it("keeps an interrupted child paused under a Stop hold and failed after it releases", async () => {
	const { controller, holds, sessionId } = await subject(true);
	holds.push({ kind: "session_hold", since: "2026-10-21T00:00:00.000Z" });
	controller.reportChild({
		taskId: "task",
		childSessionId: sessionId,
		runEpoch: 1,
		generation: 1,
		state: "failed",
		terminal: "interrupted",
	});
	controller.idle();
	expect(controller.snapshot.state).toBe("paused");
	holds.length = 0;
	controller.recompute();
	expect(controller.snapshot).toMatchObject({
		state: "failed",
		failure: { reason: "interrupted", taskId: "task", runEpoch: 1 },
	});
});

it("keeps an idle child non-terminal until its current task record is terminal", async () => {
	const { controller } = await subject(true);
	controller.idle();
	expect(controller.snapshot.state).not.toBe("done");
});

for (const kind of ["session_hold", "inherited_hold", "run_fence", "unattended"] as const) {
	it(`invalidates self-settle when a ${kind} is added before the seal`, async () => {
		// Given a standing root intent with no completed seal.
		const { controller, holds } = await subject();
		expect(controller.requestSelfSettle().recorded).toBe(true);

		// When a hold intervenes and is later released.
		holds.push({ kind, since: "2026-10-21T00:00:00.000Z" });
		controller.recompute();
		holds.length = 0;
		controller.recompute();
		controller.idle();

		// Then releasing it cannot revive the old request.
		expect(controller.snapshot.state).toBe("done");
		expect(controller.snapshot.settleDecision).toBeUndefined();
	});
}

it("discards a standing self-settle request on a failed seal", async () => {
	// Given a request recorded before a terminal provider failure.
	const { controller } = await subject();
	expect(controller.requestSelfSettle().recorded).toBe(true);

	// When no retry owns the failed turn.
	controller.goalFacts(null, input({ endedBy: "provider-error" }));
	controller.idle();

	// Then the failure never authorizes a settle decision.
	expect(controller.snapshot.state).toBe("failed");
	expect(controller.snapshot.settleDecision).toBeUndefined();
});

it.each(["senpi-task", "omo-dag", "workpool:review"])(
	"defaults untyped %s wake facts to background",
	async (source) => {
		// Given a live expectation with no producer-declared obligation kind.
		const { controller } = await subject();
		controller.goalFacts(null, input({ expectations: [{ kind: "wake-source", source }] }));

		// When its turn ends before any typed producer registry is available.
		controller.idle();

		// Then a channel's name alone cannot turn legacy background work into children.
		expect(controller.snapshot).toMatchObject({
			state: "waiting_background",
			waitingOn: { children: 0, background: [{ source, activeCount: 1 }] },
		});
	},
);
