import { describe, expect, test } from "vitest";
import {
	AllSlotsBlockedError,
	clearExpiredSlotBlocks,
	DEFAULT_POOL_AFFINITY_KEY,
	getPoolAffinityKey,
	rendezvousOrder,
	type SelectableSlot,
	type SlotHasher,
	selectSlot,
} from "../src/auth/pool/select.ts";

/** Deterministic FNV-1a 64-bit hasher; select.ts itself must not hash. */
const fnv1a64: SlotHasher = (input) => {
	let hash = 0xcbf29ce484222325n;
	for (let index = 0; index < input.length; index++) {
		hash ^= BigInt(input.charCodeAt(index));
		hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return hash;
};

const NOW = 1_756_000_000_000;

function slots(...names: string[]): SelectableSlot[] {
	return names.map((name) => ({ name }));
}

describe("credential pool affinity key", () => {
	test("explicit affinityKey wins, sessionId is the fallback, then the default", () => {
		expect(getPoolAffinityKey({ affinityKey: "k", sessionId: "s" })).toBe("k");
		expect(getPoolAffinityKey({ sessionId: "s" })).toBe("s");
		expect(getPoolAffinityKey({})).toBe(DEFAULT_POOL_AFFINITY_KEY);
	});
});

describe("credential pool HRW ordering", () => {
	test("ordering is deterministic for a fixed key and slot set", () => {
		const pool = slots("alpha", "beta", "gamma", "delta");
		const first = rendezvousOrder("session-1", pool, fnv1a64).map((slot) => slot.name);
		const second = rendezvousOrder("session-1", pool, fnv1a64).map((slot) => slot.name);
		expect(first).toEqual(second);
		expect([...first].sort()).toEqual(["alpha", "beta", "delta", "gamma"]);
	});

	test("different keys can rendezvous with different winners", () => {
		const pool = slots("alpha", "beta", "gamma", "delta", "epsilon");
		const winners = new Set(
			Array.from({ length: 64 }, (_, index) => rendezvousOrder(`key-${index}`, pool, fnv1a64)[0]?.name),
		);
		expect(winners.size).toBeGreaterThan(1);
	});

	test("removing a non-winning slot keeps the winner stable", () => {
		const pool = slots("alpha", "beta", "gamma", "delta");
		const winner = rendezvousOrder("stable-key", pool, fnv1a64)[0];
		if (!winner) throw new Error("expected a winner");
		const reduced = pool.filter((slot) => slot.name !== "delta" || winner.name === "delta");
		expect(rendezvousOrder("stable-key", reduced, fnv1a64)[0]?.name).toBe(winner.name);
	});
});

describe("credential pool slot selection", () => {
	test("an unblocked pinned slot wins over HRW order", () => {
		const pool = slots("alpha", "beta", "gamma");
		const selected = selectSlot(pool, { hasher: fnv1a64, affinityKey: "k", pinnedSlot: "gamma", now: NOW });
		expect(selected.name).toBe("gamma");
	});

	test("a blocked pinned slot falls back to the HRW winner", () => {
		const pool: SelectableSlot[] = [
			{ name: "alpha" },
			{ name: "beta" },
			{ name: "gamma", blockedUntil: NOW + 60_000, blockReason: "rate_limit" },
		];
		const selected = selectSlot(pool, { hasher: fnv1a64, affinityKey: "k", pinnedSlot: "gamma", now: NOW });
		expect(selected.name).not.toBe("gamma");
		const hrw = rendezvousOrder("k", pool, fnv1a64).filter((slot) => slot.name !== "gamma");
		expect(selected.name).toBe(hrw[0]?.name);
	});

	test("a blocked HRW winner is skipped for the next unblocked slot", () => {
		const pool = slots("alpha", "beta", "gamma");
		const order = rendezvousOrder("k2", pool, fnv1a64);
		const winner = order[0];
		if (!winner) throw new Error("expected a winner");
		const blocked = pool.map((slot) =>
			slot.name === winner.name ? { ...slot, blockedUntil: NOW + 60_000, blockReason: "rate_limit" } : slot,
		);
		const selected = selectSlot(blocked, { hasher: fnv1a64, affinityKey: "k2", now: NOW });
		expect(selected.name).toBe(order[1]?.name);
	});

	test("an elapsed rate-limit block clears, an auth block does not", () => {
		const pool: SelectableSlot[] = [
			{ name: "alpha", blockedUntil: NOW - 1, blockReason: "rate_limit" },
			{ name: "beta", blockReason: "auth_error" },
		];
		const cleared = clearExpiredSlotBlocks(pool, NOW);
		expect(cleared[0]).toEqual({ name: "alpha" });
		expect(cleared[1]).toEqual({ name: "beta", blockReason: "auth_error" });
	});

	test("selection recovers from a stale persisted block via the cleared view", () => {
		const pool: SelectableSlot[] = [
			{ name: "alpha", blockedUntil: NOW - 5_000, blockReason: "rate_limit" },
			{ name: "beta", blockReason: "auth_error" },
		];
		const selected = selectSlot(pool, { hasher: fnv1a64, affinityKey: "k", now: NOW });
		expect(selected.name).toBe("alpha");
	});

	test("a fully blocked pool throws with the soonest unblock time", () => {
		const pool: SelectableSlot[] = [
			{ name: "alpha", blockedUntil: NOW + 120_000, blockReason: "rate_limit" },
			{ name: "beta", blockedUntil: NOW + 60_000, blockReason: "rate_limit" },
		];
		try {
			selectSlot(pool, { hasher: fnv1a64, affinityKey: "k", now: NOW });
			throw new Error("expected AllSlotsBlockedError");
		} catch (error) {
			expect(error).toBeInstanceOf(AllSlotsBlockedError);
			expect((error as AllSlotsBlockedError).soonestUnblockAt).toBe(NOW + 60_000);
		}
	});
});
