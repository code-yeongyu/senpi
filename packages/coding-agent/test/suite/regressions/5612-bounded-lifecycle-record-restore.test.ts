/**
 * senpi#5612: a `session-lifecycle` record is bounded however many background sources are open, and a transcript
 * written before the fix (records naming every consumed delivery of a run that was killed mid-run) still restores to
 * the same lifecycle and custody state without writing another record of that size.
 */
import { expect, it } from "vitest";
import type { LifecycleRecord } from "../../../src/core/lifecycle-record.ts";
import { SessionLifecycleController } from "../../../src/core/session-lifecycle.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { WorkCustodyRecord } from "../../../src/core/work-custody-record.ts";

function controllerOver(manager: SessionManager): SessionLifecycleController {
	return new SessionLifecycleController({
		sessionId: manager.getSessionId(),
		entries: manager.getEntries(),
		append: (record) => manager.appendCustomEntry("session-lifecycle", record),
		appendChild: (record) => manager.appendCustomEntry("child-lifecycle", record),
		appendCustody: (record) => manager.appendCustomEntry("work-custody", record),
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
			holds: [],
			human: [],
		}),
	});
}

function lifecycleRecords(manager: SessionManager): LifecycleRecord[] {
	return manager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === "session-lifecycle" ? [entry.data as LifecycleRecord] : [],
		);
}

function recordBytes(record: LifecycleRecord): number {
	return Buffer.byteLength(JSON.stringify(record));
}

it("a record stays under 8 KB with 2,000 open background sources and still reports their true count", () => {
	// Given a running session that opens 2,000 background wait sources.
	const manager = SessionManager.inMemory();
	const controller = controllerOver(manager);
	controller.restoreComplete();
	controller.startRun();
	for (let index = 0; index < 2000; index += 1) controller.obligations.open(`wake:${index}`, "background");
	controller.idle();

	// Then no record grew with them, and the last one counts every source.
	const records = lifecycleRecords(manager);
	expect(Math.max(...records.map(recordBytes))).toBeLessThan(8192);
	const waits = records.at(-1)?.waitingOn;
	expect(waits?.background).toHaveLength(32);
	expect((waits?.background.length ?? 0) + (waits?.backgroundOmitted ?? 0)).toBe(2000);
	expect(controller.snapshot.state).toBe("waiting_background");
});

function consumedDelivery(index: number, runId: string): WorkCustodyRecord {
	return {
		id: `consumed-${index}`,
		key: `delivery:omo-senpi:wake:${index}`,
		kind: "background",
		state: "consumed",
		ticketId: `ticket-${index}`,
		runId,
		transcriptEntryId: `entry-${index}`,
	};
}

/** The shape the pre-fix engine wrote when the process was killed inside a run that had consumed many deliveries. */
function killedMidRunBeforeTheFix(consumed: number): { manager: SessionManager; runId: string } {
	const manager = SessionManager.inMemory();
	const controller = controllerOver(manager);
	controller.restoreComplete();
	controller.humanInput(new Date().toISOString());
	controller.startRun();
	const runId = controller.ledger.runId;
	const last = lifecycleRecords(manager).at(-1);
	if (!runId || !last) throw new Error("the run wrote no record");
	const deliveries = Array.from({ length: consumed }, (_, index) => consumedDelivery(index, runId));
	const queued: WorkCustodyRecord = {
		id: "queued",
		key: "delivery:omo-senpi:wake:queued",
		kind: "background",
		state: "queued",
		ticketId: "ticket-queued",
		payload: { message: { customType: "wake", content: "wake", display: false }, deliverAs: "steer" },
	};
	for (const record of [...deliveries, queued]) manager.appendCustomEntry("work-custody", record);
	manager.appendCustomEntry("session-lifecycle", {
		...last,
		seq: last.seq + 1,
		state: "running",
		runActive: true,
		waitingOn: {
			children: 0,
			human: [],
			background: [...deliveries, queued].map((record) => ({ source: record.key, activeCount: 1 })),
		},
	} satisfies LifecycleRecord);
	return { manager, runId };
}

it("a transcript written before the fix restores to the same state without re-amplifying", () => {
	// Given a pre-fix transcript whose last record names 200 consumed deliveries and one queued delivery.
	const { manager, runId } = killedMidRunBeforeTheFix(200);
	const before = lifecycleRecords(manager).length;

	// When it is restored.
	const restored = controllerOver(manager);
	const loaded = restored.snapshot;
	restored.restoreComplete();

	// Then the loaded snapshot keeps the true count without holding every name.
	expect(loaded.waitingOn?.background).toHaveLength(32);
	expect((loaded.waitingOn?.background.length ?? 0) + (loaded.waitingOn?.backgroundOmitted ?? 0)).toBe(201);
	// And it resumes the same interrupted run, with its consumed custody kept for crash recovery (senpi#4848).
	expect(restored.ledger.runId).toBe(runId);
	expect(restored.ledger.interrupted).toBe(true);
	expect(restored.snapshot.state).toBe("waiting_human");
	expect(restored.snapshot.waitingOn?.human.map((wait) => wait.kind)).toEqual(["interrupted_run"]);
	expect(restored.obligations.active.filter((record) => record.state === "consumed")).toHaveLength(200);
	expect(restored.obligations.active.filter((record) => record.state === "queued").map((r) => r.id)).toEqual([
		"queued",
	]);
	// And the records it writes on load name only what it still waits on.
	const written = lifecycleRecords(manager).slice(before);
	expect(written.length).toBeGreaterThan(0);
	for (const record of written) {
		expect(record.waitingOn?.background.map((wait) => wait.source)).toEqual(["delivery:omo-senpi:wake:queued"]);
		expect(recordBytes(record)).toBeLessThan(4096);
	}

	// When the resumed session starts its next run and goes idle.
	restored.startRun("human");
	restored.idle();

	// Then the interrupted run's consumed deliveries settle as they did before the fix (senpi#4435).
	expect(restored.obligations.active.filter((record) => record.state === "consumed")).toEqual([]);
});
