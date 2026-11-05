import type { JsonValue } from "@earendil-works/pi-ai";
import type { HandEpochFence } from "./remote-epoch.ts";
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
	/**
	 * The user machine's end of the link to the loop host. It must outlive this process (the machine's long-lived link
	 * endpoint): a `started` still unacknowledged when the endpoint dies is lost, and the loop host then sends the call
	 * again to the replacement process, which runs the hooks a second time.
	 */
	readonly transport: Transport;
	readonly lane: string;
	readonly run: LoopHookRunner;
	/**
	 * The hand's epoch fence (S35) and the authenticated sender of this link (senpi#5916): an epoch-bearing call runs only
	 * while the tool scope its payload names has a floor and the fence admits the call's epoch from that sender.
	 */
	readonly fence?: HandEpochFence;
	readonly sender?: string;
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

	// A known call id was answered above, before this check, so a re-send after a floor rise still gets its answer.
	const fenceRefusal = (call: LoopHookCall): string | undefined => {
		const { fence, sender } = options;
		if (fence === undefined || call.epoch === undefined) return undefined;
		const payload = call.payload;
		const scope =
			typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload.scope : undefined;
		const scopeId =
			typeof scope === "object" && scope !== null && !Array.isArray(scope) && typeof scope.id === "string"
				? scope.id
				: undefined;
		if (scopeId === undefined || fence.floorOf(scopeId) === undefined) return "floor_missing";
		return fence.admits(scopeId, call.epoch, sender ?? "") ? undefined : "epoch_fenced";
	};

	const serve = async (call: LoopHookCall): Promise<void> => {
		if (answers.has(call.callId)) {
			const answer = answers.get(call.callId);
			if (answer !== undefined) await send(answer);
			return;
		}
		const refusal = fenceRefusal(call);
		if (refusal !== undefined) return send({ kind: "hook.failed", callId: call.callId, error: refusal });
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
