import type { JsonValue } from "@earendil-works/pi-ai";
import type { Transport, TransportFrame } from "../transport/transport.ts";
import {
	decodeLoopHookMessage,
	encodeLoopHookMessage,
	type LoopHookCall,
	type LoopHookMessage,
} from "./loop-hook-host-protocol.ts";

/** Runs the user's hooks for one loop event on this machine and returns what they produced. */
export type LoopHookRunner = (event: string, payload: JsonValue) => Promise<JsonValue>;

/** The points of one hook call on the hand, in order; a kill-point probe may stop the process at any of them. */
export type LoopHookPoint = "received" | "started" | "ran" | "replied";

export interface LoopHookHandOptions {
	/** The user machine's end of the link to the loop host. */
	readonly transport: Transport;
	readonly lane: string;
	readonly run: LoopHookRunner;
	/** This process's identity; a new one per process start. */
	readonly instance?: string;
	/** Test-only probe: throwing here stops this process at that point, as a kill does. */
	readonly onPoint?: (point: LoopHookPoint, callId: string) => void;
	readonly onFault?: (error: unknown) => void;
}

export interface LoopHookHand {
	/** Resolves once this process announced itself to the loop host. */
	readonly ready: Promise<void>;
	close(): void;
}

/**
 * The user machine's side of the loop-hook link (S33): runs each hook call once per process and answers a repeated call
 * from its stored answer. It announces itself first, and says `started` before any hook runs, so the loop host can tell
 * a call this process never began (safe to send again) from one it may have run (never sent again).
 */
export function serveLoopHooks(options: LoopHookHandOptions): LoopHookHand {
	const { transport, lane } = options;
	const instance = options.instance ?? crypto.randomUUID();
	const answers = new Map<string, LoopHookMessage | undefined>();
	let dead = false;

	const send = (message: LoopHookMessage): Promise<void> => transport.send(lane, encodeLoopHookMessage(message));
	const point = (at: LoopHookPoint, callId: string): void => {
		if (dead) throw new Error("this hand process was stopped");
		try {
			options.onPoint?.(at, callId);
		} catch (error) {
			dead = true;
			throw error;
		}
	};

	const serve = async (call: LoopHookCall): Promise<void> => {
		if (answers.has(call.callId)) {
			const answer = answers.get(call.callId);
			if (answer !== undefined) await send(answer);
			return;
		}
		point("received", call.callId);
		answers.set(call.callId, undefined);
		await send({ kind: "hook.started", callId: call.callId, instance });
		point("started", call.callId);
		let answer: LoopHookMessage;
		try {
			answer = { kind: "hook.reply", callId: call.callId, result: await options.run(call.event, call.payload) };
		} catch (error) {
			answer = {
				kind: "hook.failed",
				callId: call.callId,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		point("ran", call.callId);
		answers.set(call.callId, answer);
		await send(answer);
		point("replied", call.callId);
	};

	transport.onFrame(async (frame: TransportFrame) => {
		if (dead) return;
		const message = decodeLoopHookMessage(frame.payload);
		if (message?.kind !== "hook.call") return;
		try {
			await serve(message);
		} catch (error) {
			options.onFault?.(error);
		}
	});

	return {
		ready: send({ kind: "hook.hello", instance }),
		close() {
			dead = true;
		},
	};
}
