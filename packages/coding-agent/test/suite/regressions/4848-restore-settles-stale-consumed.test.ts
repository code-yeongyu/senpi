import { expect, it } from "vitest";
import { SessionLifecycleController } from "../../../src/core/session-lifecycle.ts";
import type { SpawnedBy } from "../../../src/core/session-lifecycle-types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { WorkCustodyRecord } from "../../../src/core/work-custody-record.ts";

// senpi#4848 (#5254): a run that ended without settling what it consumed left that custody `consumed` forever, so the
// restored session reported `waiting_background` and never reached `done`. Restoring settles the consumed custody of
// every run that is not the ledger's current run; the current run's own consumed custody stays for crash recovery.
function restore(manager: SessionManager, spawnedBy?: SpawnedBy): SessionLifecycleController {
	const controller = new SessionLifecycleController({
		sessionId: manager.getSessionId(),
		...(spawnedBy ? { spawnedBy } : {}),
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

function startTurn(controller: SessionLifecycleController): string {
	controller.humanInput(new Date().toISOString());
	controller.noteRunAdmitted();
	controller.admissionSettled();
	controller.startRun();
	const runId = controller.ledger.runId;
	if (!runId) throw new Error("the run has no id");
	return runId;
}

function custody(
	id: string,
	state: WorkCustodyRecord["state"],
	runId: string,
	kind: WorkCustodyRecord["kind"] = "background",
): WorkCustodyRecord {
	return { id, key: `delivery:${id}`, kind, state, ticketId: `ticket-${id}`, runId, transcriptEntryId: `entry-${id}` };
}

function custodyWrites(manager: SessionManager): WorkCustodyRecord[] {
	return manager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === "work-custody" ? [entry.data as WorkCustodyRecord] : [],
		);
}

function stuckSession(records: readonly WorkCustodyRecord[], spawnedBy?: SpawnedBy): SessionManager {
	const manager = SessionManager.inMemory();
	const controller = restore(manager, spawnedBy);
	startTurn(controller);
	controller.idle();
	for (const record of records) manager.appendCustomEntry("work-custody", record);
	return manager;
}

it("settles consumed custody of an ended run on restore, so the session reaches done", () => {
	// Given a finished session holding two consumed deliveries of an earlier run, as #5254 held 345.
	const manager = stuckSession([custody("a", "consumed", "ended-run"), custody("b", "consumed", "ended-run")]);

	// When it is restored.
	const restored = restore(manager);

	// Then nothing of that ended run holds it open and it reports done.
	expect(restored.obligations.active).toEqual([]);
	expect(restored.snapshot.state).toBe("done");
	expect(restored.snapshot.waitingOn?.background ?? []).toEqual([]);
	// And the repair is durable: each record's latest write is a settle.
	expect(new Map(custodyWrites(manager).map((record) => [record.id, record.state]))).toEqual(
		new Map([
			["a", "settled"],
			["b", "settled"],
		]),
	);
});

it("writes nothing on a second restore", () => {
	// Given a stuck session that was restored once.
	const manager = stuckSession([custody("a", "consumed", "ended-run")]);
	restore(manager);
	const written = custodyWrites(manager).length;

	// When it is restored again.
	const again = restore(manager);

	// Then no custody record is written and it stays done.
	expect(custodyWrites(manager).length).toBe(written);
	expect(again.snapshot.state).toBe("done");
});

it("leaves every custody state other than consumed as it was", () => {
	// Given an earlier run's records in every non-consumed state.
	const states = ["open", "queued", "passive", "held", "settled", "cancelled"] as const;
	const manager = stuckSession(states.map((state) => custody(state, state, "ended-run")));
	const written = custodyWrites(manager).length;

	// When it is restored.
	const restored = restore(manager);

	// Then none of them is rewritten, and the open and queued ones still hold the session.
	expect(custodyWrites(manager).length).toBe(written);
	expect(restored.obligations.active.map((record) => [record.id, record.state])).toEqual([
		["open", "open"],
		["queued", "queued"],
	]);
});

it("keeps the interrupted current run's consumed custody for crash recovery", () => {
	// Given a session that died during a run which had consumed a delivery, and an ended run's leftover.
	const manager = SessionManager.inMemory();
	const runId = startTurn(restore(manager));
	manager.appendCustomEntry("work-custody", custody("current", "consumed", runId));
	manager.appendCustomEntry("work-custody", custody("stale", "consumed", "ended-run"));

	// When it is restored.
	const restored = restore(manager);

	// Then only the ended run's custody is settled; the interrupted run keeps its own.
	expect(restored.ledger.interrupted).toBe(true);
	expect(restored.obligations.active.map((record) => [record.id, record.state])).toEqual([["current", "consumed"]]);
});

it("keeps consumed custody when the ledger records no run", () => {
	// Given custody restored beside no lifecycle record at all.
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry("work-custody", custody("a", "consumed", "unrecorded-run"));
	const written = custodyWrites(manager).length;

	// When it is restored.
	const restored = restore(manager);

	// Then nothing proves that run ended, so crash recovery keeps it.
	expect(restored.ledger.runId).toBeUndefined();
	expect(custodyWrites(manager).length).toBe(written);
	expect(restored.obligations.active.map((record) => [record.id, record.state])).toEqual([["a", "consumed"]]);
});

it("settles a child session's consumed custody of an ended run", () => {
	// Given a child session holding consumed custody of an earlier run.
	const spawnedBy: SpawnedBy = { parentSessionId: "parent", rootSessionId: "parent", taskId: "task-1" };
	const manager = stuckSession([custody("a", "consumed", "ended-run", "children")], spawnedBy);

	// When it is restored.
	const restored = restore(manager, spawnedBy);

	// Then it no longer waits on that custody; its task record, not its local idle, decides when it is done.
	expect(restored.obligations.active).toEqual([]);
	expect(restored.snapshot.waitingOn?.children).toBe(0);
	expect(restored.snapshot.state).toBe("running");
});
