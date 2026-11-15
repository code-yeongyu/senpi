// senpi#6767 (omo-service#1176 gap 3): one wake the loop cannot take does not hold every wake behind it. Each failure
// is reported; the wake stays for a bounded number of drains, then it is taken as poisoned and reported once more.
import { describe, expect, it } from "vitest";
import { createAdmissionLine } from "../../src/durable/store-admission.ts";
import { createMemoryStoreMedium, openMemoryStore } from "../../src/durable/store-memory.ts";
import { scopeSessionCheck } from "../../src/execution/wake-delivery.ts";
import { createWakeInbox } from "../../src/execution/wake-inbox.ts";
import type { WakeEvent } from "../../src/execution/wake-types.ts";

const wakeOf = (index: number): WakeEvent => ({ eventId: `h:${index}`, scope: "s", source: "message", payload: index });

async function inboxWith(wakes: readonly WakeEvent[], failures: unknown[]) {
	const medium = createMemoryStoreMedium();
	await openMemoryStore(medium).claim(0, 1);
	const inbox = createWakeInbox({
		issuer: "brain",
		store: openMemoryStore(medium),
		epoch: 1,
		admission: createAdmissionLine(),
		clock: () => 0,
		owner: () => "hand",
		maxAttempts: 3,
		onUndeliverable: (failure) => failures.push(failure),
	});
	for (const wake of wakes) await inbox.receive("hand", wake);
	return inbox;
}

describe("a wake re-sent after its ack was lost (review round 3, M1)", () => {
	it("gets its receipt again even after its session left the scope: no refusal, so no drop report and no fault", async () => {
		let sessions = new Set(["loop-1"]);
		const medium = createMemoryStoreMedium();
		await openMemoryStore(medium).claim(0, 1);
		const inbox = createWakeInbox({
			issuer: "brain",
			store: openMemoryStore(medium),
			epoch: 1,
			admission: createAdmissionLine(),
			clock: () => 0,
			owner: () => "hand",
		});
		const check = scopeSessionCheck(() => sessions);
		const wake: WakeEvent = {
			eventId: "h:1",
			scope: "s",
			source: "notice",
			payload: { message: "late", sessionId: "loop-1" },
		};

		const first = await inbox.receive("hand", wake, check);
		sessions = new Set(["loop-2"]);
		const resent = await inbox.receive("hand", wake, check);

		expect([first, resent]).toEqual([
			{ kind: "ack", eventId: "h:1", duplicate: false },
			{ kind: "ack", eventId: "h:1", duplicate: true },
		]);
		expect((await inbox.read()).pending.map((entry) => entry.eventId)).toEqual(["h:1"]);
	});
});

describe("draining a brain's wake inbox", () => {
	it("delivers the wakes behind one the loop cannot take, reports each failure, and poisons it after its attempts", async () => {
		const failures: unknown[] = [];
		const inbox = await inboxWith([wakeOf(1), wakeOf(2), wakeOf(3)], failures);
		const taken: string[] = [];
		const consume = async (wake: WakeEvent) => {
			if (wake.eventId === "h:2") throw new Error("the session is gone");
			taken.push(wake.eventId);
		};

		const first = await inbox.drain(consume);
		expect([first, taken]).toEqual([2, ["h:1", "h:3"]]);
		expect((await inbox.read()).pending.map((wake) => wake.eventId)).toEqual(["h:2"]);
		await inbox.drain(consume);
		await inbox.drain(consume);

		expect((await inbox.read()).pending).toEqual([]);
		expect(failures).toEqual([
			expect.objectContaining({ wake: wakeOf(2), attempts: 1, poisoned: false }),
			expect.objectContaining({ wake: wakeOf(2), attempts: 2, poisoned: false }),
			expect.objectContaining({ wake: wakeOf(2), attempts: 3, poisoned: true }),
		]);
		expect(await inbox.drain(consume)).toBe(0);
	});
});
