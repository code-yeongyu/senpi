import type { JsonValue } from "@earendil-works/pi-ai";
import type { Transport, TransportFrame } from "../transport/transport.ts";
import {
	decodeLoopHookMessage,
	encodeLoopHookMessage,
	type LoopHookCall,
	type LoopHookMessage,
	type LoopHookRefusal,
} from "./loop-hook-host-protocol.ts";
import { createLoopHookSessionQueues } from "./loop-hook-session-queue.ts";

/**
 * How long a call waits, by default, for each call ahead of it in its session to settle (the bound restarts each time one
 * does): a session's default event handler cap (20 min).
 */
export const DEFAULT_LOOP_HOOK_QUEUE_WAIT_MS = 1_200_000;

const REFUSAL_MESSAGES: Record<LoopHookRefusal, string> = {
	cancelled: "the loop cancelled this call before its hooks started",
	queue_timeout:
		"a call ahead of this one in its session did not settle within the queue cap; this call's hooks did not run",
};

/**
 * Runs the user's hooks for one loop event on this machine and returns what they produced. `signal` aborts when the loop
 * host cancels the call (its caller stopped waiting).
 */
export type LoopHookRunner = (event: string, payload: JsonValue, signal: AbortSignal) => Promise<JsonValue>;

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
	 * The session a call belongs to, read from its event and payload; `undefined` puts the call in no queue. One session's
	 * calls run one at a time and different sessions' side by side (a lane may carry many sessions).
	 */
	readonly sessionOf: (event: string, payload: JsonValue) => string | undefined;
	/**
	 * How long a call waits for each call ahead of it in its session to settle before it is refused (`queue_timeout`).
	 * The bound restarts each time a call ahead settles, so it catches a stuck call, never a slow queue that keeps moving.
	 * A value past `setTimeout`'s range (2^31 - 1 ms, about 24.8 days) waits that long instead.
	 */
	readonly queueWaitMs?: number;
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
 * a call this process never began (safe to send again) from one it may have run (never sent again). It runs each
 * session's calls one at a time and still reads the lane while they run, so a cancel reaches its call (see the ordering
 * paragraph of `loop-hook-host-protocol.ts`).
 */
export function serveLoopHooks(options: LoopHookHandOptions): LoopHookHand {
	const { transport, lane } = options;
	const instance = options.instance ?? crypto.randomUUID();
	const answers = new Map<string, LoopHookMessage | undefined>();
	/** The calls received and not yet answered, by ID, so a cancel reaches them, running or waiting their turn. */
	const running = new Map<string, AbortController>();
	const turnOf = createLoopHookSessionQueues();
	const queueWaitMs = options.queueWaitMs ?? DEFAULT_LOOP_HOOK_QUEUE_WAIT_MS;
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
		// Registered and queued before the first await: a cancel the lane delivers right behind its call finds it, and a
		// session's calls run one at a time, in the order they arrived.
		const controller = new AbortController();
		running.set(call.callId, controller);
		const turn = turnOf(options.sessionOf(call.event, call.payload), controller.signal, queueWaitMs);
		try {
			const outcome = await turn.ready;
			if (outcome !== "turn") {
				// No `started` is sent: the hooks never ran, so the loop host may treat the call as never begun.
				const refused: LoopHookMessage = {
					kind: "hook.failed",
					callId: call.callId,
					error: REFUSAL_MESSAGES[outcome],
					reason: outcome,
				};
				answers.set(call.callId, refused);
				await send(refused);
				return;
			}
			await send({ kind: "hook.started", callId: call.callId, instance });
			point("started", call.callId);
			let answer: LoopHookMessage;
			try {
				const result = await options.run(call.event, call.payload, controller.signal);
				answer = { kind: "hook.reply", callId: call.callId, result };
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
		} finally {
			running.delete(call.callId);
			turn.leave();
		}
	};

	transport.onFrame((frame: TransportFrame) => {
		if (dead) return;
		const message = decodeLoopHookMessage(frame.payload);
		if (message?.kind === "hook.cancel") {
			running.get(message.callId)?.abort();
			return;
		}
		if (message?.kind !== "hook.call") return;
		// Not awaited: the transport holds a lane until its handler settles, and the call's cancel follows it on the lane.
		serve(message).catch((error: unknown) => options.onFault?.(error));
	});

	return {
		ready: send({ kind: "hook.hello", instance }),
		close() {
			dead = true;
		},
	};
}
