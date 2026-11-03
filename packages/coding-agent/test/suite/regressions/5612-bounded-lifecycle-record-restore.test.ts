/**
 * senpi#5612: a `session-lifecycle` record carries only the background sources that changed, restore rebuilds the
 * full set by replaying those changes, and a transcript written before the fix (records naming every consumed
 * delivery of a run that was killed mid-run) still restores to the same lifecycle and custody state.
 */
import { expect, it } from "vitest";
import type { LifecycleRecord } from "../../../src/core/lifecycle-record.ts";
import { SessionLifecycleController } from "../../../src/core/session-lifecycle.ts";
import type { LifecycleWaits } from "../../../src/core/session-lifecycle-types.ts";
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

function total(waits: LifecycleWaits | undefined): number {
	return (waits?.background.length ?? 0) + (waits?.backgroundOmitted ?? 0);
}

it("2,000 open background sources write records that carry only the change, and restore replays the full set", () => {
	// Given a running session that opens 2,000 background wait sources and then closes 500 of them.
	const manager = SessionManager.inMemory();
	const controller = controllerOver(manager);
	controller.restoreComplete();
	controller.startRun();
	const tokens = Array.from({ length: 2000 }, (_, index) =>
		controller.obligations.open(`wake:${index}`, "background"),
	);
	for (const token of tokens.slice(0, 500)) token.close("cancelled");
	controller.idle();

	// Then no record names a source or grew with them, and the last one counts every open source.
	const records = lifecycleRecords(manager);
	expect(Math.max(...records.map(recordBytes))).toBeLessThan(2048);
	expect(Math.max(...records.map((record) => record.waitingOn?.background.length ?? 0))).toBe(0);
	expect(total(records.at(-1)?.waitingOn)).toBe(1500);
	// And the live snapshot names the first 32 and counts the rest.
	const live = controller.snapshot.waitingOn;
	expect(live?.background).toHaveLength(32);
	expect(total(live)).toBe(1500);
	expect(controller.snapshot.state).toBe("waiting_background");

	// When the transcript is restored, its replayed changes rebuild exactly the live set.
	const restored = controllerOver(manager).snapshot.waitingOn;
	expect(restored?.background).toEqual(live?.background);
	expect(total(restored)).toBe(1500);
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
function killedMidRunBeforeTheFix(consumed: number): { manager: SessionManager; runId: string; oldRecord: number } {
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
	const { backgroundChanges: _changes, ...preFix } = last;
	const old: LifecycleRecord = {
		...preFix,
		seq: last.seq + 1,
		state: "running",
		runActive: true,
		waitingOn: {
			children: 0,
			human: [],
			background: [...deliveries, queued].map((record) => ({ source: record.key, activeCount: 1 })),
		},
	};
	manager.appendCustomEntry("session-lifecycle", old);
	return { manager, runId, oldRecord: recordBytes(old) };
}

it("a transcript written before the fix restores to the same state without re-amplifying", () => {
	// Given a pre-fix transcript whose last record names 200 consumed deliveries and one queued delivery.
	const { manager, runId, oldRecord } = killedMidRunBeforeTheFix(200);
	const before = lifecycleRecords(manager).length;

	// When it is restored.
	const restored = controllerOver(manager);
	const loaded = restored.snapshot;
	restored.restoreComplete();

	// Then the loaded snapshot keeps the true count without holding every name.
	expect(loaded.waitingOn?.background).toHaveLength(32);
	expect(total(loaded.waitingOn)).toBe(201);
	// And it resumes the same interrupted run, with its consumed custody kept for crash recovery (senpi#4848).
	expect(restored.ledger.runId).toBe(runId);
	expect(restored.ledger.interrupted).toBe(true);
	expect(restored.snapshot.state).toBe("waiting_human");
	expect(restored.snapshot.waitingOn?.human.map((wait) => wait.kind)).toEqual(["interrupted_run"]);
	expect(restored.snapshot.waitingOn?.background.map((wait) => wait.source)).toEqual([
		"delivery:omo-senpi:wake:queued",
	]);
	expect(restored.obligations.active.filter((record) => record.state === "consumed")).toHaveLength(200);
	expect(restored.obligations.active.filter((record) => record.state === "queued").map((r) => r.id)).toEqual([
		"queued",
	]);
	// And loading writes the stale names away once, in less than the old record took, and never again.
	const written = lifecycleRecords(manager).slice(before);
	expect(written.length).toBeGreaterThan(0);
	expect(written[0]?.backgroundChanges?.removed).toHaveLength(200);
	expect(written.reduce((sum, record) => sum + recordBytes(record), 0)).toBeLessThan(oldRecord);
	for (const record of written.slice(1)) expect(recordBytes(record)).toBeLessThan(2048);
	// And a second restore replays the old full list plus the changes to the same single source.
	expect(controllerOver(manager).snapshot.waitingOn?.background.map((wait) => wait.source)).toEqual([
		"delivery:omo-senpi:wake:queued",
	]);

	// When the resumed session starts its next run and goes idle.
	restored.startRun("human");
	restored.idle();

	// Then the interrupted run's consumed deliveries settle as they did before the fix (senpi#4435).
	expect(restored.obligations.active.filter((record) => record.state === "consumed")).toEqual([]);
});
