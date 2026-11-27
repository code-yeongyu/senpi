import { expect, it } from "vitest";
import { lifecycleHistory } from "../../../src/core/lifecycle-history.ts";
import { SessionLifecycleController } from "../../../src/core/session-lifecycle.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { CustodyPayload, WorkCustodyRecord } from "../../../src/core/work-custody-record.ts";

// senpi#7603: a closed custody record kept the payload of its delivery, in memory for the life of the session and in
// every closing record the journal wrote. A closed record now keeps only its identity. What admission answers for a
// ticket must not change, also for a journal written before the change.

const payload: CustodyPayload = { message: { customType: "wake", content: "delivered body", display: false } };

function delivery(name: string, state: WorkCustodyRecord["state"], extra: Partial<WorkCustodyRecord> = {}) {
	return {
		id: `custody-${name}`,
		key: `delivery:${name}`,
		kind: "background" as const,
		state,
		ticketId: `ticket-${name}`,
		payload,
		...extra,
	};
}

/** A journal written the way closing records were written before: each one repeats the queued record's payload. */
function oldFormatSession(): SessionManager {
	const manager = SessionManager.inMemory();
	const sessionId = manager.getSessionId();
	const write = (record: ReturnType<typeof delivery>) =>
		manager.appendCustomEntry("work-custody", { ...record, sessionId });
	for (const name of ["settled", "held", "cancelled", "passive"]) write(delivery(name, "queued"));
	write(delivery("settled", "consumed", { runId: "ended-run", transcriptEntryId: "entry-settled" }));
	write(delivery("settled", "settled", { runId: "ended-run", transcriptEntryId: "entry-settled" }));
	write(delivery("held", "held", { noticeId: "notice-held" }));
	write(delivery("cancelled", "cancelled"));
	write(delivery("passive", "passive"));
	write(delivery("consumed", "consumed", { runId: "current-run", transcriptEntryId: "entry-consumed" }));
	write(delivery("admitted", "queued"));
	write(delivery("delivering", "queued"));
	return manager;
}

/** Restores the session's lifecycle from the fold, as the session binding does, and records what custody it writes. */
function restore(manager: SessionManager) {
	const written: WorkCustodyRecord[] = [];
	const controller = new SessionLifecycleController({
		sessionId: manager.getSessionId(),
		entries: manager.reduceHistory(lifecycleHistory),
		append: () => {},
		appendChild: () => {},
		appendCustody: (record) => written.push(record),
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
	return { controller, written };
}

function foldedCustody(manager: SessionManager, id: string): unknown {
	for (const entry of manager.reduceHistory(lifecycleHistory)) {
		if (entry.type !== "custom" || entry.customType !== "work-custody") continue;
		if (typeof entry.data === "object" && entry.data !== null && Reflect.get(entry.data, "id") === id)
			return entry.data;
	}
	return undefined;
}

it("answers the same admission for every ticket of a journal whose closing records carry the payload", () => {
	const { controller, written } = restore(oldFormatSession());
	const obligations = controller.obligations;
	expect(obligations.queue("ticket-delivering", payload)).toBe(true);
	const names = ["unknown", "settled", "held", "cancelled", "passive", "consumed", "delivering", "admitted"];
	expect(Object.fromEntries(names.map((name) => [name, obligations.admission(`ticket-${name}`)]))).toEqual({
		unknown: "unknown",
		settled: "closed",
		held: "closed",
		cancelled: "closed",
		passive: "closed",
		consumed: "consumed",
		delivering: "delivering",
		admitted: "admitted",
	});
	// Every transition on a closed ticket stays a no-op: it neither throws nor writes.
	for (const name of ["settled", "held", "cancelled", "passive"]) {
		const ticket = `ticket-${name}`;
		expect(obligations.queue(ticket, payload)).toBe(false);
		obligations.passive(ticket);
		obligations.consumed(ticket, { runId: "another-run", transcriptEntryId: "another-entry" });
		obligations.failed(ticket);
		obligations.held(ticket, "another-notice");
		obligations.retire(ticket);
		obligations.cancel(ticket);
		obligations.endDelivery(ticket);
		expect(obligations.admission(ticket)).toBe("closed");
	}
	expect(written.map((record) => record.ticketId)).toEqual(["ticket-delivering"]);
	// Open custody keeps its payload and its place: restoration resends queued deliveries from it.
	expect(obligations.active.map((record) => [record.ticketId, record.payload])).toEqual([
		["ticket-consumed", payload],
		["ticket-admitted", payload],
		["ticket-delivering", payload],
	]);
});

it("keeps a closed record's identity, not its payload, in the fold and in the closing records it writes", () => {
	const manager = oldFormatSession();
	expect(foldedCustody(manager, "custody-settled")).toEqual({
		id: "custody-settled",
		key: "delivery:settled",
		kind: "background",
		state: "settled",
		ticketId: "ticket-settled",
		sessionId: manager.getSessionId(),
	});
	expect(foldedCustody(manager, "custody-held")).toMatchObject({ state: "held", noticeId: "notice-held" });
	expect(foldedCustody(manager, "custody-held")).not.toHaveProperty("payload");
	expect(foldedCustody(manager, "custody-admitted")).toMatchObject({ state: "queued", payload });

	const { controller, written } = restore(manager);
	controller.obligations.settleRun("current-run");
	expect(written).toEqual([
		{
			id: "custody-consumed",
			key: "delivery:consumed",
			kind: "background",
			state: "settled",
			ticketId: "ticket-consumed",
		},
	]);
});
