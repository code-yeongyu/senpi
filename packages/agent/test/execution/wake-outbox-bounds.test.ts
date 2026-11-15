// senpi#6767 review round 2: the outbox stays bounded by its pending work (M3), and overflow never evicts a wake
// already sent and awaiting its ack (L6): only a wake the brain refused for good is evicted, otherwise the new one is
// refused before it is sent, so every overflow report is true.
import { describe, expect, it } from "vitest";
import { createAdmissionLine } from "../../src/durable/store-admission.ts";
import { createMemoryStoreMedium, openMemoryStore } from "../../src/durable/store-memory.ts";
import { createWakeOutbox } from "../../src/execution/wake-outbox.ts";
import { WAKE_RETENTION_MS } from "../../src/execution/wake-types.ts";

const DAY = 24 * 60 * 60 * 1000;

async function outboxWith(limits: { perScope: number; total: number }) {
	const medium = createMemoryStoreMedium();
	await openMemoryStore(medium).claim(0, 1);
	const store = openMemoryStore(medium);
	const clock = { now: 0 };
	const outbox = createWakeOutbox({
		hand: "h",
		store,
		epoch: 1,
		admission: createAdmissionLine(),
		clock: () => clock.now,
		limits,
	});
	const record = async () => (await store.scanDocuments("execution.wake-outbox:"))[0]?.data as Record<string, unknown>;
	return { outbox, clock, record };
}

const wakeOf = (index: number) => ({ scope: "s", source: "message", payload: { index } });

describe("a bounded wake outbox", () => {
	it("keeps no state for wakes the brain refused for good once they are evicted or lapsed (the reviewer's probe)", async () => {
		const { outbox, clock, record } = await outboxWith({ perScope: 2, total: 10 });
		for (let index = 0; index < 50; index++) {
			const wake = await outbox.offer(wakeOf(index));
			await outbox.receipt({ kind: "refused", eventId: wake.eventId, reason: "scope_closed" });
		}
		clock.now += WAKE_RETENTION_MS + DAY;
		await outbox.sweep();

		const kept = await record();
		expect([kept.pending, kept.refused]).toEqual([[], {}]);
		const reports = (kept.drops as { payload: { reason: string; count: number } }[]).map((drop) => drop.payload);
		expect(reports.every((report) => report.reason === "refused")).toBe(true);
		expect(reports.reduce((total, report) => total + report.count, 0)).toBe(50);
	});

	it("never evicts a sent wake awaiting its ack: past the bound it refuses the new wake and reports that one", async () => {
		const { outbox } = await outboxWith({ perScope: 2, total: 10 });
		const sent = [await outbox.offer(wakeOf(0)), await outbox.offer(wakeOf(1))];

		await expect(outbox.offer(wakeOf(2))).rejects.toMatchObject({ name: "WakeOverflowError" });

		expect((await outbox.pending()).map((wake) => wake.eventId)).toEqual(sent.map((wake) => wake.eventId));
		expect((await outbox.due()).filter((wake) => wake.source === "wake.dropped").map((drop) => drop.payload)).toEqual(
			[{ reason: "overflow", count: 1 }],
		);
	});
});
