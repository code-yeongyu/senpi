import { decodeLoopHookMessage, type LoopHookMessage } from "../../src/execution/loop-hook-host-protocol.ts";
import type { FrameHandler, Transport } from "../../src/transport/transport.ts";

/**
 * Two in-memory transport ends for the loop-hook link; frames wait until `flush`. `drop` loses the hand's frames of one
 * kind, in its outbox. `sentByHand` lists every message the hand sent, in order (dropped ones included).
 */
export function transportPair(drop: { kind?: string } = {}) {
	const queues: { to: "loop" | "hand"; payload: Uint8Array }[] = [];
	const handlers: { loop?: FrameHandler; hand?: FrameHandler } = {};
	const sentByHand: LoopHookMessage[] = [];
	const end = (self: "loop" | "hand", peer: "loop" | "hand"): Transport => ({
		send: async (_lane, payload) => {
			const message = decodeLoopHookMessage(payload);
			if (self === "hand" && message !== undefined) sentByHand.push(message);
			if (self === "hand" && message?.kind === drop.kind) return;
			queues.push({ to: peer, payload });
		},
		onFrame: (handler) => {
			handlers[self] = handler;
		},
		inFlight: () => 0,
		close: () => {},
	});
	const flush = async (): Promise<void> => {
		for (let turn = 0; turn < 64; turn++) {
			const next = queues.shift();
			if (next === undefined) await Promise.resolve();
			else await handlers[next.to]?.({ lane: "hooks", payload: next.payload });
		}
	};
	return { loop: end("loop", "hand"), hand: end("hand", "loop"), flush, sentByHand };
}
