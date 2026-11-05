// senpi#5860: a claim winner that died before its floor ack must not strand the session. The hand's owner record may
// name the epoch the owner's claim recorded; that owner raises straight to it, a stale copy of the record is read again
// once before a raise ahead of it is refused, and every earlier owner stays fenced.
import { describe, expect, it } from "vitest";
import { createAdmissionLine } from "../../src/durable/store-admission.ts";
import { createMemoryStoreMedium, openMemoryStore } from "../../src/durable/store-memory.ts";
import { createHandEpochFence, type ScopeOwner } from "../../src/execution/remote-epoch.ts";
import { createEpochGate } from "../../src/execution/remote-epoch-gate.ts";

describe("epoch catch-up to the owner's recorded epoch (senpi#5860)", () => {
	it("a winner that died before its raise does not strand the scope, and earlier owners stay fenced", async () => {
		let owner: ScopeOwner = { principal: "a", epoch: 1 };
		const fence = createHandEpochFence({ ownerOf: () => owner });
		expect(await fence.raise("s", 1, "a")).toEqual({ kind: "acked", floor: 1 });
		owner = { principal: "c", epoch: 3 };

		expect(await fence.raise("s", 3, "c")).toEqual({ kind: "acked", floor: 3 });
		expect([fence.admits("s", 3, "c"), fence.admits("s", 1, "a"), fence.admits("s", 2, "b")]).toEqual([
			true,
			false,
			false,
		]);
		expect(await fence.raise("s", 2, "b")).toEqual({ kind: "refused", reason: "peer_unauthorized" });
	});

	it("caps the raise at the recorded epoch, and an owner without one keeps the one-step cap", async () => {
		const recorded = createHandEpochFence({ ownerOf: () => ({ principal: "c", epoch: 3 }) });
		expect(await recorded.raise("s", 4, "c")).toEqual({ kind: "refused", reason: "epoch_step_exceeded" });
		const plain = createHandEpochFence({ ownerOf: () => "c" });
		expect(await plain.raise("s", 3, "c")).toEqual({ kind: "refused", reason: "epoch_step_exceeded" });
	});

	it("reads a stale record once before refusing a raise ahead of it; never for one at or below it", async () => {
		let record: ScopeOwner = { principal: "a", epoch: 1 };
		let copy: ScopeOwner = record;
		let reads = 0;
		const fence = createHandEpochFence({
			ownerOf: () => copy,
			refreshOwner: async () => {
				reads += 1;
				copy = record;
				return copy;
			},
		});
		await fence.raise("s", 1, "a");
		record = { principal: "b", epoch: 2 };

		expect(await fence.raise("s", 1, "x")).toEqual({ kind: "refused", reason: "peer_unauthorized" });
		expect(reads).toBe(0);
		expect(await fence.raise("s", 2, "b")).toEqual({ kind: "acked", floor: 2 });
		expect(reads).toBe(1);
		expect(fence.admits("s", 1, "a")).toBe(false);
		expect(await fence.raise("s", 5, "x")).toEqual({ kind: "refused", reason: "peer_unauthorized" });
		expect(reads).toBe(2);
	});

	it("coalesces concurrent reads of one scope's record", async () => {
		const record: ScopeOwner = { principal: "b", epoch: 2 };
		let reads = 0;
		const gate = Promise.withResolvers<void>();
		const fence = createHandEpochFence({
			ownerOf: () => ({ principal: "a", epoch: 1 }),
			refreshOwner: async () => {
				reads += 1;
				await gate.promise;
				return record;
			},
		});
		const first = fence.raise("s", 2, "b");
		const second = fence.raise("s", 2, "b");
		gate.resolve();

		expect(await Promise.all([first, second])).toEqual([
			{ kind: "acked", floor: 2 },
			{ kind: "acked", floor: 2 },
		]);
		expect(reads).toBe(1);
	});

	it("with no floor yet, an earlier instance of the record's owner opens it at the recorded epoch and is superseded", async () => {
		const fence = createHandEpochFence({ ownerOf: () => ({ principal: "p", epoch: 2 }) });

		expect(await fence.raise("s", 1, "p")).toEqual({ kind: "acked", floor: 2 });
		expect(fence.admits("s", 1, "p")).toBe(false);
		const gate = createEpochGate(1, async () => {});
		const verdict = gate.open("s");
		gate.answer("s", { kind: "floor_ack", floor: 2 });
		expect(await verdict).toBe("epoch_superseded");
		expect(await fence.raise("s", 2, "p")).toEqual({ kind: "acked", floor: 2 });
	});

	it("a durable fence reads the record outside the ledger's admission line, once for concurrent raises", async () => {
		const store = openMemoryStore(createMemoryStoreMedium());
		await store.claim(0, 1);
		const admission = createAdmissionLine();
		let reads = 0;
		const reply = Promise.withResolvers<ScopeOwner>();
		const fence = createHandEpochFence({
			ownerOf: () => ({ principal: "a", epoch: 1 }),
			refreshOwner: async () => {
				reads += 1;
				return reply.promise;
			},
			durable: { store, epoch: 1, admission },
		});
		const first = fence.raise("s", 2, "b");
		const second = fence.raise("s", 2, "b");
		for (let turn = 0; turn < 64 && reads === 0; turn++) await Promise.resolve();
		let stepRan = false;
		const step = admission.admit(async () => {
			stepRan = true;
		});
		for (let turn = 0; turn < 64 && !stepRan; turn++) await Promise.resolve();

		expect(reads).toBe(1);
		expect(stepRan).toBe(true);
		reply.resolve({ principal: "b", epoch: 2 });
		await step;
		expect(await Promise.all([first, second])).toEqual([
			{ kind: "acked", floor: 2 },
			{ kind: "acked", floor: 2 },
		]);
		expect(reads).toBe(1);
		expect(await fence.raise("s", 2, "b")).toEqual({ kind: "acked", floor: 2 });
		expect(reads).toBe(1);
	});

	it("a raise that joined a read started before its claim landed reads once more, so the new owner is not stranded", async () => {
		const replies = [Promise.withResolvers<ScopeOwner>(), Promise.withResolvers<ScopeOwner>()];
		let reads = 0;
		const fence = createHandEpochFence({
			ownerOf: () => ({ principal: "a", epoch: 1 }),
			refreshOwner: async () => {
				const reply = replies[reads];
				reads += 1;
				if (reply === undefined) throw new Error("an unexpected record read");
				return reply.promise;
			},
		});
		const byC = fence.raise("s", 2, "c");
		for (let turn = 0; turn < 64 && reads === 0; turn++) await Promise.resolve();
		const byB = fence.raise("s", 3, "b");
		replies[0]?.resolve({ principal: "c", epoch: 2 });
		for (let turn = 0; turn < 64 && reads < 2; turn++) await Promise.resolve();
		replies[1]?.resolve({ principal: "b", epoch: 3 });

		expect(await Promise.all([byC, byB])).toEqual([
			{ kind: "acked", floor: 2 },
			{ kind: "acked", floor: 3 },
		]);
		expect(reads).toBe(2);
		expect(fence.admits("s", 2, "c")).toBe(false);
	});

	it("answers the record's owner below its recorded epoch with the floor in force, which its gate reads as superseded", async () => {
		let owner: ScopeOwner = { principal: "a", epoch: 1 };
		const fence = createHandEpochFence({ ownerOf: () => owner });
		await fence.raise("s", 1, "a");
		owner = { principal: "b", epoch: 3 };

		expect(await fence.raise("s", 2, "b")).toEqual({ kind: "acked", floor: 1 });
		expect(fence.admits("s", 1, "a")).toBe(true);
		const gate = createEpochGate(2, async () => {});
		const verdict = gate.open("s");
		gate.answer("s", { kind: "floor_ack", floor: 1 });
		expect(await verdict).toBe("epoch_superseded");
	});
});
