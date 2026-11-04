// senpi#5729 (S35): the hand's epoch fence follows SP6's raise rules (relay-spec#126), and the floor records fail
// closed on the wire. The integrated move, kill and multi-session behavior is in epoch-conformance.test.ts.
import { describe, expect, it } from "vitest";
import { createHandEpochFence } from "../../src/execution/remote-epoch.ts";
import { createEpochGate } from "../../src/execution/remote-epoch-gate.ts";
import { createRemoteToolHost } from "../../src/execution/remote-tool-host.ts";
import type { FrameHandler, Transport } from "../../src/transport/transport.ts";
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

// Review fold (#5739): an answer counts only while the lane is waiting for one, and a resend makes the lane wait again,
// so a late or duplicate answer cannot flip a decided lane and re-sent calls never overtake the re-sent floor.
describe("session floor gate", () => {
	const ACK = { kind: "floor_ack", floor: 2 } as const;
	const REFUSED = { kind: "floor_refused", reason: "peer_unauthorized" } as const;
	const now = (verdict: Promise<string | undefined>) => Promise.race([verdict, Promise.resolve("pending")]);
	it.each([
		{
			name: "a late refusal after the ack keeps the lane open",
			steps: [ACK, REFUSED],
			resend: false,
			expected: undefined,
		},
		{
			name: "a late ack after a refusal keeps the lane closed",
			steps: [REFUSED, ACK],
			resend: false,
			expected: "peer_unauthorized",
		},
		{ name: "after a resend the lane waits for the new answer", steps: [ACK], resend: true, expected: "pending" },
	])("$name", async ({ steps, resend, expected }) => {
		const floors: string[] = [];
		const gate = createEpochGate(2, async (lane) => void floors.push(lane));
		void gate.open("s");
		for (const answer of steps) gate.answer("s", answer);
		if (resend) gate.resend();
		expect(await now(gate.open("s"))).toBe(expected);
		expect(floors).toEqual(resend ? ["s", "s"] : ["s"]);
	});

	it("lets the answer to a resend decide the lane, and never resends a refused lane", async () => {
		const floors: string[] = [];
		const gate = createEpochGate(2, async (lane) => void floors.push(lane));
		void gate.open("s");
		void gate.open("t");
		gate.answer("s", ACK);
		gate.answer("t", REFUSED);
		gate.resend();
		gate.answer("s", REFUSED);
		expect([await now(gate.open("s")), await now(gate.open("t")), floors]).toEqual([
			"peer_unauthorized",
			"peer_unauthorized",
			["s", "t", "s"],
		]);
	});
});

describe("remote ToolHost after a hand restart", () => {
	it("re-sends a pending call only after the hand acked the re-sent floor", async () => {
		const frames: string[] = [];
		let handler: FrameHandler | undefined;
		const transport: Transport = {
			send: async (_lane, payload) => {
				const message = decodeRemoteMessage(payload);
				frames.push(message.kind);
			},
			onFrame: (next) => {
				handler = next;
			},
			inFlight: () => 0,
			close: () => {},
		};
		const settle = async () => {
			for (let turn = 0; turn < 16; turn++) await Promise.resolve();
		};
		const from = async (lane: string, message: Parameters<typeof encodeRemoteMessage>[0]) => {
			await handler?.({ lane, payload: encodeRemoteMessage(message) });
			await settle();
		};
		const host = createRemoteToolHost({ transport, placement: "split-local", epoch: 2 });
		void host.execute(
			{
				scope: { id: "s", root: "/w" },
				calls: [{ type: "toolCall", id: "c", name: "probe", arguments: {} }],
				mode: "parallel",
			},
			{ emit: () => {} },
		);
		await settle();
		await from("s", { kind: "floor_ack", floor: 2 });
		await from("hand.control", { kind: "hello", instance: "restarted" });
		const beforeAck = [...frames];
		await from("s", { kind: "floor_ack", floor: 2 });
		expect([beforeAck, frames]).toEqual([
			["floor", "invoke", "floor"],
			["floor", "invoke", "floor", "invoke"],
		]);
		host.close();
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
