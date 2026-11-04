// senpi#5729 (S35): the hand's epoch fence follows SP6's raise rules (relay-spec#126), and the floor records fail
// closed on the wire. The integrated move, kill and multi-session behavior is in epoch-conformance.test.ts.
import { describe, expect, it } from "vitest";
import { createHandEpochFence } from "../../src/execution/remote-epoch.ts";
import { decodeRemoteMessage, encodeRemoteMessage, RemoteProtocolError } from "../../src/execution/remote-protocol.ts";

const owned = (owner = "a") => createHandEpochFence({ ownerOf: (scope) => (scope === "s" ? owner : undefined) });

describe("hand epoch fence (SP6 raise rules)", () => {
	it("raises one epoch at a time from 0, answers a lower epoch with the floor, and never lowers", async () => {
		const fence = owned();
		expect(await fence.raise("s", 2, "a")).toEqual({ kind: "refused", reason: "epoch_step_exceeded" });
		expect(await fence.raise("s", 1, "a")).toEqual({ kind: "acked", floor: 1 });
		expect(await fence.raise("s", 2, "a")).toEqual({ kind: "acked", floor: 2 });
		expect(await fence.raise("s", 1, "a")).toEqual({ kind: "acked", floor: 2 });
		expect(await fence.raise("s", Number.MAX_SAFE_INTEGER, "a")).toEqual({
			kind: "refused",
			reason: "epoch_step_exceeded",
		});
		expect([fence.admits("s", 1, "a"), fence.admits("s", 2, "a"), fence.admits("s", 3, "a")]).toEqual([
			false,
			true,
			true,
		]);
	});

	it("lets only the scope's owner raise, and fences a rival at the floor's epoch", async () => {
		let owner = "a";
		const fence = createHandEpochFence({ ownerOf: (scope) => (scope === "s" ? owner : undefined) });
		expect(await fence.raise("t", 1, "a")).toEqual({ kind: "refused", reason: "peer_unauthorized" });
		expect(await fence.raise("s", 1, "b")).toEqual({ kind: "refused", reason: "peer_unauthorized" });
		await fence.raise("s", 1, "a");
		owner = "b";
		expect(await fence.raise("s", 1, "b")).toEqual({ kind: "refused", reason: "epoch_fenced" });
		expect([fence.admits("s", 1, "a"), fence.admits("s", 1, "b"), fence.admits("s", undefined, "a")]).toEqual([
			true,
			false,
			false,
		]);
		expect([fence.admits("t", undefined, "b")]).toEqual([true]);
	});
});

describe("floor records on the wire", () => {
	it("round-trips the floor, its ack, its refusal and an epoch-stamped invoke", () => {
		const messages = [
			{ kind: "floor", epoch: 3 },
			{ kind: "floor_ack", floor: 3 },
			{ kind: "floor_refused", reason: "epoch_fenced" },
			{ kind: "ack", executionId: "e1", epoch: 3 },
		] as const;
		for (const message of messages) expect(decodeRemoteMessage(encodeRemoteMessage(message))).toEqual(message);
	});

	it.each([
		["a floor with no epoch", { kind: "floor" }],
		["a zero epoch", { kind: "floor", epoch: 0 }],
		["a fractional epoch", { kind: "floor", epoch: 1.5 }],
		["an unsafe epoch", { kind: "floor", epoch: 2 ** 53 }],
		["a string ack floor", { kind: "floor_ack", floor: "1" }],
		["an unknown refusal", { kind: "floor_refused", reason: "nope" }],
		["a negative invoke epoch", { kind: "abort", executionId: "e1", epoch: -1 }],
	])("refuses %s", (_label, value) => {
		expect(() => decodeRemoteMessage(new TextEncoder().encode(JSON.stringify(value)))).toThrow(RemoteProtocolError);
	});
});
