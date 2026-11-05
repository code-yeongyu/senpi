// senpi#6040 (invariant I5 of #6030): once the embedder removes a scope's owner record, the owner the hand last read
// is no longer the owner; its raise is refused, as before record reads existed, until a fresh read names an owner again.
import { describe, expect, it } from "vitest";
import { createAdmissionLine } from "../../src/durable/store-admission.ts";
import { createMemoryStoreMedium, openMemoryStore } from "../../src/durable/store-memory.ts";
import { createHandEpochFence, type ScopeOwner } from "../../src/execution/remote-epoch.ts";

/** A durable fence whose admission line is held by one ledger step until `release`, and whose reads answer in order. */
async function heldFence(ownerOf: () => ScopeOwner | undefined, reads: (ScopeOwner | undefined)[]) {
	const store = openMemoryStore(createMemoryStoreMedium());
	await store.claim(0, 1);
	const admission = createAdmissionLine();
	const fence = createHandEpochFence({
		ownerOf,
		refreshOwner: async () => reads.shift(),
		durable: { store, epoch: 1, admission },
	});
	await fence.ready;
	const step = Promise.withResolvers<void>();
	const held = admission.admit(() => step.promise);
	const settle = async (): Promise<void> => {
		for (let turn = 0; turn < 64; turn++) await Promise.resolve();
	};
	const release = async (): Promise<void> => {
		step.resolve();
		await held;
	};
	return { fence, settle, release };
}

describe("a removed owner record (senpi#6040)", () => {
	it("refuses the last-read owner once the record is gone", async () => {
		let record: ScopeOwner | undefined = { principal: "b", epoch: 2 };
		let copy: ScopeOwner | undefined = { principal: "a", epoch: 1 };
		const fence = createHandEpochFence({ ownerOf: () => copy, refreshOwner: async () => record });
		expect(await fence.raise("s", 2, "b")).toEqual({ kind: "acked", floor: 2 });
		record = undefined;
		copy = undefined;

		expect(await fence.raise("s", 2, "b")).toEqual({ kind: "refused", reason: "peer_unauthorized" });
		record = { principal: "a", epoch: 1 };
		copy = { principal: "a", epoch: 1 };
		expect(await fence.raise("s", 2, "b")).toEqual({ kind: "refused", reason: "peer_unauthorized" });
	});

	it("a raise is decided on the newest record read at its turn, not its own older one", async () => {
		let copy: ScopeOwner | undefined = { principal: "a", epoch: 1 };
		const h = await heldFence(
			() => copy,
			[
				{ principal: "b", epoch: 3 },
				{ principal: "c", epoch: 4 },
			],
		);
		const byB = h.fence.raise("s", 3, "b");
		await h.settle();
		const byC = h.fence.raise("s", 4, "c");
		await h.settle();
		copy = undefined;
		await h.release();

		expect(await byB).toEqual({ kind: "refused", reason: "peer_unauthorized" });
		expect(await byC).toEqual({ kind: "acked", floor: 4 });
	});

	it("a newer read finding the record removed refuses a raise that read it earlier", async () => {
		const copy: ScopeOwner = { principal: "a", epoch: 1 };
		const h = await heldFence(() => copy, [{ principal: "b", epoch: 3 }, undefined]);
		const byB = h.fence.raise("s", 3, "b");
		await h.settle();
		const byX = h.fence.raise("s", 5, "x");
		await h.settle();
		await h.release();

		expect(await byB).toEqual({ kind: "refused", reason: "peer_unauthorized" });
		expect(await byX).toEqual({ kind: "refused", reason: "peer_unauthorized" });
		expect(h.fence.admits("s", 3, "b")).toBe(true);
	});

	it("a read that found the record removed outranks a copy still naming its owner, until a fresh read names one", async () => {
		const reads: (ScopeOwner | undefined)[] = [undefined, undefined, { principal: "b", epoch: 2 }];
		const fence = createHandEpochFence({
			ownerOf: () => ({ principal: "b", epoch: 2 }),
			refreshOwner: async () => reads.shift(),
		});
		expect(await fence.raise("s", 3, "x")).toEqual({ kind: "refused", reason: "peer_unauthorized" });

		expect(await fence.raise("s", 2, "b")).toEqual({ kind: "refused", reason: "peer_unauthorized" });
		expect(await fence.raise("s", 2, "b")).toEqual({ kind: "acked", floor: 2 });
	});

	it("a copy missing for a moment is not a removal: an older copy coming back never outranks the last read", async () => {
		const copies: (ScopeOwner | undefined)[] = [
			{ principal: "a", epoch: 1 },
			{ principal: "a", epoch: 1 },
			{ principal: "a", epoch: 1 },
			undefined,
		];
		const fence = createHandEpochFence({
			ownerOf: () => (copies.length > 0 ? copies.shift() : { principal: "a", epoch: 2 }),
			refreshOwner: async () => ({ principal: "b", epoch: 3 }),
		});
		expect(await fence.raise("s", 3, "x")).toEqual({ kind: "refused", reason: "peer_unauthorized" });
		expect(await fence.raise("s", 2, "b")).toEqual({ kind: "refused", reason: "peer_unauthorized" });

		expect(await fence.raise("s", 2, "a")).toEqual({ kind: "refused", reason: "peer_unauthorized" });
		expect(fence.admits("s", 2, "a")).toBe(true);
		expect(await fence.raise("s", 3, "b")).toEqual({ kind: "acked", floor: 3 });
		expect(fence.admits("s", 2, "a")).toBe(false);
	});
});
