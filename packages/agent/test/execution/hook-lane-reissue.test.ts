// senpi#5916 (brain side): the loop host stamps its epoch at each transmission, re-issues the same call once per epoch
// when the hand's refusal echoes an older epoch, and handles hook.restarted by the instance that started the call.
import type { JsonValue } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createLoopHookHost, LoopHookRestartedError } from "../../src/execution/loop-hook-host.ts";
import { serveLoopHooks } from "../../src/execution/loop-hook-host-hand.ts";
import {
	decodeLoopHookMessage,
	encodeLoopHookMessage,
	type LoopHookCall,
	type LoopHookMessage,
} from "../../src/execution/loop-hook-host-protocol.ts";
import { createHandEpochFence } from "../../src/execution/remote-epoch.ts";
import type { FrameHandler, Transport } from "../../src/transport/transport.ts";

const LANE = "hooks";
const SCOPE_PAYLOAD = { scope: { id: "s", root: "/w" } };

function link() {
	const toHand: Uint8Array[] = [];
	const toLoop: Uint8Array[] = [];
	const calls: LoopHookCall[] = [];
	const handlers: { loop?: FrameHandler; hand?: FrameHandler } = {};
	const end = (self: "loop" | "hand", queue: Uint8Array[]): Transport => ({
		send: async (_lane, payload) => {
			const message = decodeLoopHookMessage(payload);
			if (message?.kind === "hook.call") calls.push(message);
			queue.push(payload);
		},
		onFrame: (handler) => {
			handlers[self] = handler;
		},
		inFlight: () => 0,
		close: () => {},
	});
	const pump = async (): Promise<void> => {
		for (let turn = 0; turn < 64; turn++) {
			const loopFrame = toLoop.shift();
			if (loopFrame !== undefined) await handlers.loop?.({ lane: LANE, payload: loopFrame });
			const handFrame = toHand.shift();
			if (handFrame !== undefined) await handlers.hand?.({ lane: LANE, payload: handFrame });
			await Promise.resolve();
		}
	};
	const takeForHand = (): Uint8Array[] => toHand.splice(0);
	const deliverToHand = async (frames: readonly Uint8Array[]): Promise<void> => {
		for (const payload of frames) await handlers.hand?.({ lane: LANE, payload });
	};
	const deliverToLoop = async (message: LoopHookMessage): Promise<void> =>
		handlers.loop?.({ lane: LANE, payload: encodeLoopHookMessage(message) });
	return {
		loop: end("loop", toHand),
		hand: end("hand", toLoop),
		calls,
		pump,
		takeForHand,
		deliverToHand,
		deliverToLoop,
	};
}

function settledState(result: Promise<JsonValue>) {
	const state: { value?: JsonValue; error?: unknown } = {};
	result.then(
		(value) => {
			state.value = value;
		},
		(error: unknown) => {
			state.error = error;
		},
	);
	return state;
}

async function brainAndHand() {
	const epoch = { current: 1 };
	const runs: string[] = [];
	const l = link();
	const fence = createHandEpochFence({ ownerOf: () => "brain-b" });
	await fence.raise("s", 1, "brain-b");
	const host = createLoopHookHost({ transport: l.loop, lane: LANE, epoch: () => epoch.current });
	serveLoopHooks({
		transport: l.hand,
		lane: LANE,
		fence,
		ownerOf: () => "brain-b",
		sender: "brain-b",
		run: async (event) => {
			runs.push(event);
			return { ran: runs.length };
		},
	});
	await l.pump();
	return { epoch, runs, l, fence, host };
}

describe("the loop host re-issues a call refused at an older epoch (senpi#5916)", () => {
	it("(i) raise first: a re-delivery at E after the floor rose to E+1 is refused, re-issued at E+1, and runs once", async () => {
		const { epoch, runs, l, fence, host } = await brainAndHand();
		const state = settledState(host.run("before_agent_start", SCOPE_PAYLOAD));
		const held = l.takeForHand();
		await fence.raise("s", 2, "brain-b");
		epoch.current = 2;
		await l.deliverToHand(held);
		await l.pump();

		expect(runs).toEqual(["before_agent_start"]);
		expect(l.calls.map((call) => call.epoch)).toEqual([1, 2]);
		expect(state).toEqual({ value: { ran: 1 } });
	});

	it("(ii) frame first: the re-delivered frame lands while the floor is still E and runs once, never re-issued", async () => {
		const { epoch, runs, l, fence, host } = await brainAndHand();
		const state = settledState(host.run("before_agent_start", SCOPE_PAYLOAD));
		await l.deliverToHand(l.takeForHand());
		await fence.raise("s", 2, "brain-b");
		epoch.current = 2;
		await l.pump();

		expect(runs).toEqual(["before_agent_start"]);
		expect(l.calls.map((call) => call.epoch)).toEqual([1]);
		expect(state).toEqual({ value: { ran: 1 } });
	});

	it("(iii) a second stale echo at the same epoch is ignored: exactly one frame at E+1 and the call stays open", async () => {
		const epoch = { current: 1 };
		const l = link();
		const host = createLoopHookHost({
			transport: l.loop,
			lane: LANE,
			epoch: () => epoch.current,
			mintId: () => "c1",
		});
		const state = settledState(host.run("before_agent_start", SCOPE_PAYLOAD));
		epoch.current = 2;
		const stale: LoopHookMessage = { kind: "hook.refused", callId: "c1", reason: "epoch_fenced", epoch: 1, floor: 2 };
		await l.deliverToLoop(stale);
		await l.deliverToLoop(stale);

		expect(l.calls.map((call) => call.epoch)).toEqual([1, 2]);
		expect(host.waiting()).toEqual(["c1"]);
		expect(state).toEqual({});
	});

	it("a refusal at the current epoch ends the call with the hand's reason", async () => {
		const l = link();
		const host = createLoopHookHost({ transport: l.loop, lane: LANE, epoch: () => 1, mintId: () => "c1" });
		const result = host.run("before_agent_start", SCOPE_PAYLOAD);
		await l.deliverToLoop({ kind: "hook.refused", callId: "c1", reason: "floor_missing", epoch: 1 });
		await expect(result).rejects.toThrow("floor_missing");
	});
});

describe("hook.restarted on the loop host (senpi#5916)", () => {
	const started = async (startedBy: string | undefined) => {
		const l = link();
		const host = createLoopHookHost({ transport: l.loop, lane: LANE, mintId: () => "c1" });
		const state = settledState(host.run("before_agent_start", SCOPE_PAYLOAD));
		if (startedBy !== undefined) await l.deliverToLoop({ kind: "hook.started", callId: "c1", instance: startedBy });
		return { l, host, state };
	};

	it("is ignored when the instance that started the call answers it", async () => {
		const { l, host, state } = await started("p1");
		await l.deliverToLoop({ kind: "hook.restarted", callId: "c1", instance: "p1" });
		expect(host.waiting()).toEqual(["c1"]);
		expect(state).toEqual({});
	});

	it("rejects LoopHookRestartedError when another instance answers it", async () => {
		const { l, state } = await started("p1");
		await l.deliverToLoop({ kind: "hook.restarted", callId: "c1", instance: "p2" });
		await Promise.resolve();
		expect(state.error).toBeInstanceOf(LoopHookRestartedError);
	});

	it("rejects LoopHookRestartedError when the call was never reported started", async () => {
		const { l, state } = await started(undefined);
		await l.deliverToLoop({ kind: "hook.restarted", callId: "c1", instance: "p2" });
		await Promise.resolve();
		expect(state.error).toBeInstanceOf(LoopHookRestartedError);
	});
});
