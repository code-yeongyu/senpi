// senpi#5867 (loop-hook link): a hook call keyed from durable turn state reaches the user's machine's answer when a fresh
// loop issues it again, so the hooks run once.
import type { JsonValue } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createLoopHookHost, LoopHookClosedError, loopHookCallKey } from "../../src/execution/loop-hook-host.ts";
import { serveLoopHooks } from "../../src/execution/loop-hook-host-hand.ts";
import type { FrameHandler, Transport } from "../../src/transport/transport.ts";

function transportPair() {
	const queues: { to: "loop" | "hand"; payload: Uint8Array }[] = [];
	const handlers: { loop?: FrameHandler; hand?: FrameHandler } = {};
	const end = (self: "loop" | "hand", peer: "loop" | "hand"): Transport => ({
		send: async (_lane, payload) => void queues.push({ to: peer, payload }),
		onFrame: (handler) => {
			handlers[self] = handler;
		},
		inFlight: () => 0,
		close: () => {},
	});
	const flush = async (): Promise<void> => {
		for (let turn = 0; turn < 64; turn++) {
			const next = queues.shift();
			// A handler is not awaited: a hook still running must not hold the link's other frames.
			if (next !== undefined) void handlers[next.to]?.({ lane: "hooks", payload: next.payload });
			await Promise.resolve();
		}
	};
	return { loop: end("loop", "hand"), hand: end("hand", "loop"), flush };
}

describe("durable loop-hook call keys (senpi#5867)", () => {
	it("a fresh loop issuing the same hook call of the same turn gets the answer; the hooks run once", async () => {
		const link = transportPair();
		const runs: string[] = [];
		serveLoopHooks({
			transport: link.hand,
			lane: "hooks",
			run: async (event) => {
				runs.push(event);
				return { ran: runs.length };
			},
		});
		const key = loopHookCallKey("session-a", "turn-1", "before_agent_start", 0);
		void createLoopHookHost({ transport: link.loop, lane: "hooks" }).run("before_agent_start", {}, undefined, key);
		await link.flush();

		const fresh = createLoopHookHost({ transport: link.loop, lane: "hooks" });
		const answer = fresh.run("before_agent_start", {}, undefined, key);
		await link.flush();

		expect(await answer).toEqual({ ran: 1 });
		expect(runs).toEqual(["before_agent_start"]);
	});

	it("keys differ across sessions, turns, events and ordinals", () => {
		const keys = [
			loopHookCallKey("a", "t1", "input", 0),
			loopHookCallKey("b", "t1", "input", 0),
			loopHookCallKey("a", "t2", "input", 0),
			loopHookCallKey("a", "t1", "before_agent_start", 0),
			loopHookCallKey("a", "t1", "input", 1),
		];
		expect(new Set(keys).size).toBe(5);
	});

	it("a fresh loop issuing a started, unanswered hook call joins it: the hooks run once and the answer reaches it", async () => {
		const link = transportPair();
		const runs: string[] = [];
		let finish: (result: JsonValue) => void = () => {};
		serveLoopHooks({
			transport: link.hand,
			lane: "hooks",
			run: (event) => {
				runs.push(event);
				return new Promise<JsonValue>((resolve) => {
					finish = resolve;
				});
			},
		});
		const key = loopHookCallKey("session-a", "turn-1", "before_agent_start", 0);
		void createLoopHookHost({ transport: link.loop, lane: "hooks" }).run("before_agent_start", {}, undefined, key);
		await link.flush();

		const fresh = createLoopHookHost({ transport: link.loop, lane: "hooks" });
		const answer = fresh.run("before_agent_start", {}, undefined, key);
		await link.flush();
		finish({ ran: 1 });
		await link.flush();

		expect(await answer).toEqual({ ran: 1 });
		expect(runs).toEqual(["before_agent_start"]);
	});

	it("close rejects the waiting calls and every later call with LoopHookClosedError", async () => {
		const link = transportPair();
		const host = createLoopHookHost({ transport: link.loop, lane: "hooks" });
		const waiting = host.run("input", {});
		host.close();

		await expect(waiting).rejects.toBeInstanceOf(LoopHookClosedError);
		await expect(host.run("input", {})).rejects.toBeInstanceOf(LoopHookClosedError);
	});
});
