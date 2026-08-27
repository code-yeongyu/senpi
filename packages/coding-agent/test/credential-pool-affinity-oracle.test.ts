import { createHash } from "node:crypto";
import { TURN_RETRY_SUPPRESSION_PREFIX as POOL_PREFIX } from "@earendil-works/pi-ai/auth/pool/failover";
import {
	rendezvousOrder as poolRendezvousOrder,
	type SlotHasher,
	selectSlot,
} from "@earendil-works/pi-ai/auth/pool/select";
import { describe, expect, test } from "vitest";
import type { AccountSlot } from "../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";
import {
	rendezvousOrder as sdkRendezvousOrder,
	selectAccount,
} from "../src/core/extensions/builtin/claude-sdk-oauth/affinity.ts";
import { TURN_RETRY_SUPPRESSION_PREFIX as SDK_PREFIX } from "../src/core/extensions/builtin/claude-sdk-oauth/failover.ts";

/** The exact hash the claude-sdk-oauth oracle uses, injected into the pool engine. */
const sha256Hasher: SlotHasher = (input) => createHash("sha256").update(input).digest().readBigUInt64BE(0);

function account(name: string, extra?: Partial<AccountSlot>): AccountSlot {
	return {
		name,
		access: `${name}-access`,
		refresh: `${name}-refresh`,
		expires: 4_102_444_800_000,
		source: "login",
		...extra,
	};
}

const SLOT_NAME_SETS = [
	["default", "work"],
	["alpha", "beta", "gamma"],
	["a1", "b2", "c3", "d4", "e5"],
] as const;

describe("credential pool HRW matches the claude-sdk-oauth affinity oracle", () => {
	test("full rendezvous order is identical for every key and slot set", () => {
		for (const names of SLOT_NAME_SETS) {
			const accounts = names.map((name) => account(name));
			const slots = names.map((name) => ({ name }));
			for (let index = 0; index < 50; index++) {
				const key = `golden-session-${index}`;
				const oracle = sdkRendezvousOrder(key, accounts).map((entry) => entry.name);
				const pool = poolRendezvousOrder(key, slots, sha256Hasher).map((entry) => entry.name);
				expect(pool).toEqual(oracle);
			}
		}
	});

	test("winner selection matches the oracle when the leading slot is blocked", () => {
		const now = 1_756_000_000_000;
		for (let index = 0; index < 25; index++) {
			const key = `blocked-session-${index}`;
			const names = ["alpha", "beta", "gamma"];
			const oracleOrder = sdkRendezvousOrder(
				key,
				names.map((name) => account(name)),
			);
			const winner = oracleOrder[0];
			if (!winner) throw new Error("expected an oracle winner");
			const blockedAccounts = names.map((name) =>
				name === winner.name
					? account(name, { blockedUntil: now + 60_000, blockReason: "rate_limit" })
					: account(name),
			);
			const blockedSlots = blockedAccounts.map(({ name, blockedUntil, blockReason }) => ({
				name,
				...(blockedUntil === undefined ? {} : { blockedUntil }),
				...(blockReason === undefined ? {} : { blockReason }),
			}));
			const oracle = selectAccount(blockedAccounts, { affinityKey: key, now });
			const pool = selectSlot(blockedSlots, { hasher: sha256Hasher, affinityKey: key, now });
			expect(pool.name).toBe(oracle.name);
		}
	});

	test("the pool failover reuses the exact turn-retry suppression marker", () => {
		expect(POOL_PREFIX).toBe(SDK_PREFIX);
		expect(POOL_PREFIX).toBe("senpi:no-turn-retry:");
	});
});
