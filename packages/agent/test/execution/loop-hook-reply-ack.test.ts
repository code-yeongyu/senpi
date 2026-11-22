// senpi#5898 (#6808 review L1): the loop host settles each hook call once, by its reply or by its caller's cancel. A
// cancel that reaches the hand after the hand replied means the host dropped that reply, so the hooks' signal still
// aborts then (their effects go to the loop another way); a reply the host consumed is acknowledged, which ends that.
import { describe, expect, it } from "vitest";
import { createLoopHookHost } from "../../src/execution/loop-hook-host.ts";
import { serveLoopHooks } from "../../src/execution/loop-hook-host-hand.ts";
import { decodeLoopHookMessage, encodeLoopHookMessage } from "../../src/execution/loop-hook-host-protocol.ts";
import type { FrameHandler, Transport } from "../../src/transport/transport.ts";

/** Two in-memory transport ends whose frames wait in one queue until delivered, one at a time or all. */
function transportPair() {
	const queue: { to: "loop" | "hand"; payload: Uint8Array }[] = [];
	const handlers: { loop?: FrameHandler; hand?: FrameHandler } = {};
	const end = (self: "loop" | "hand", peer: "loop" | "hand"): Transport => ({
		send: async (_lane, payload) => void queue.push({ to: peer, payload }),
		onFrame: (handler) => {
			handlers[self] = handler;
		},
		inFlight: () => 0,
		close: () => {},
	});
	const deliver = async (to: "loop" | "hand", payload: Uint8Array) => {
		await handlers[to]?.({ lane: "hooks", payload });
		// The handler's own sends run on later microtasks; let them reach the queue.
		for (let turn = 0; turn < 8; turn++) await Promise.resolve();
	};
	return {
		loop: end("loop", "hand"),
		hand: end("hand", "loop"),
		/** Kinds of the frames queued toward `to`, oldest first. */
		queued: (to: "loop" | "hand") =>
			queue.filter((frame) => frame.to === to).map((frame) => decodeLoopHookMessage(frame.payload)?.kind),
		/** Delivers frames in order until one of `kind` is queued (not yet delivered). */
		async until(kind: string): Promise<void> {
			for (let turn = 0; turn < 64; turn++) {
				if (queue.some((frame) => decodeLoopHookMessage(frame.payload)?.kind === kind)) return;
				const next = queue.shift();
				if (next === undefined) await Promise.resolve();
				else await deliver(next.to, next.payload);
			}
			throw new Error(`no ${kind} frame was queued`);
		},
		async flush(): Promise<void> {
			for (let turn = 0; turn < 64; turn++) {
				const next = queue.shift();
				if (next === undefined) await Promise.resolve();
				else await deliver(next.to, next.payload);
			}
		},
		/** Delivers a frame to the hand as the loop host would send it. */
		toHand: (message: Parameters<typeof encodeLoopHookMessage>[0]) => deliver("hand", encodeLoopHookMessage(message)),
	};
}

describe("a hook call's reply and its cancel (senpi#5898)", () => {
	it("a cancel that reaches the hand after it replied still aborts the hooks' signal: the host dropped that reply", async () => {
		const link = transportPair();
		let signal: AbortSignal | undefined;
		serveLoopHooks({
			transport: link.hand,
			lane: "hooks",
			run: async (_event, _payload, hooks) => {
				signal = hooks;
				return { sent: ["m"] };
			},
		});
		const host = createLoopHookHost({ transport: link.loop, lane: "hooks" });
		const caller = new AbortController();
		const outcome = host.run("agent_end", {}, caller.signal).catch((error: unknown) => error);

		await link.until("hook.reply");
		caller.abort();
		await link.flush();

		expect(await outcome).toEqual(new Error("Operation aborted"));
		expect(signal?.aborted).toBe(true);
	});

	it("a reply the host consumed is acknowledged, and a cancel after that no longer reaches the hooks", async () => {
		const link = transportPair();
		let signal: AbortSignal | undefined;
		serveLoopHooks({
			transport: link.hand,
			lane: "hooks",
			run: async (_event, _payload, hooks) => {
				signal = hooks;
				return { sent: ["m"] };
			},
		});
		const host = createLoopHookHost({ transport: link.loop, lane: "hooks", mintId: () => "call-1" });
		const outcome = host.run("agent_end", {});

		await link.until("hook.ack");
		expect(link.queued("hand")).toEqual(["hook.ack"]);
		await link.flush();
		await link.toHand({ kind: "hook.cancel", callId: "call-1" });

		expect(await outcome).toEqual({ sent: ["m"] });
		expect(signal?.aborted).toBe(false);
	});
});
