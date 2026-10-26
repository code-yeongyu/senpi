import { expect, it } from "vitest";
import type { LifecycleRecord } from "../../../src/core/lifecycle-record.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";

// senpi#4118 review: a later run inside an epoch that is already open (a provider retry, queued messages, a second
// agent_start) carries a new runId. That run must be recorded as active, or a crash during it restores as not
// interrupted with the previous run's id.
async function controllerOn(manager: SessionManager, runtime: { pendingMessages: number }) {
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
			pendingMessages: runtime.pendingMessages,
			human: [],
			holds: [],
		}),
	});
	controller.restoreComplete();
	return controller;
}

function lifecycleRecords(manager: SessionManager): LifecycleRecord[] {
	return manager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "session-lifecycle")
		.map((entry) => (entry as { data: LifecycleRecord }).data);
}

it("records a later run in an already-open epoch as active, so a crash during it restores as interrupted", async () => {
	// Given a person's turn whose first run ended with a queued message still pending, so the epoch stays open.
	const manager = SessionManager.inMemory();
	const runtime = { pendingMessages: 0 };
	const controller = await controllerOn(manager, runtime);
	controller.humanInput(new Date().toISOString());
	controller.noteRunAdmitted();
	controller.admissionSettled();
	controller.startRun();
	const firstRunId = lifecycleRecords(manager).at(-1)?.runId;
	runtime.pendingMessages = 1;
	controller.idle();
	expect(controller.snapshot.state).toBe("running");

	// When the queued message starts the next run in the same epoch.
	runtime.pendingMessages = 0;
	controller.startRun("automatic");

	// Then the latest record carries that run as active under its own id.
	const latest = lifecycleRecords(manager).at(-1);
	expect(latest?.runActive).toBe(true);
	expect(latest?.runId).toBeDefined();
	expect(latest?.runId).not.toBe(firstRunId);

	// And a process that dies now restores the run as interrupted, asking the person to continue.
	const restarted = await controllerOn(manager, { pendingMessages: 0 });
	expect(restarted.requiresHumanContinuation).toBe(true);
});
