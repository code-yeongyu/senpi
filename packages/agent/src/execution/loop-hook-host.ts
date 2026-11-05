import type { JsonValue } from "@earendil-works/pi-ai";
import { canonicalJson } from "./canonical-digest.ts";
import type { Transport, TransportFrame } from "../transport/transport.ts";
import {
	decodeLoopHookMessage,
	encodeLoopHookMessage,
	type LoopHookCall,
	type LoopHookRefusal,
	type LoopHookRefused,
} from "./loop-hook-host-protocol.ts";

/**
 * The loop host's side of the loop-hook link (brain/hand split S33; decisions C8, K5, K7). When the loop runs on a
 * machine that is not the user's (a hosted loop), the user's loop hooks run on the user's machine: `run` sends one hook
 * call there and resolves with its result, and the caller builds the provider request only from that result, so no
 * provider request leaves without it. While that machine is unreachable the call simply waits (the work is paused), and
 * the transport delivers it once the machine is back, so it resumes exactly once. A fused or split-local session never
 * builds this host: its hooks run in its own process, as today.
 *
 * Restarts: a call the previous hand process never started is sent again, with the same ID, to the new one. A call it
 * had started (and so may have run) is never sent again: it ends with {@link LoopHookRestartedError}. "Started" is what
 * this host received, so this holds only while the hand's transport endpoint outlives the hand process (see
 * `loop-hook-host-protocol.ts`).
 */
export interface LoopHookHost {
	/** Runs the user's hooks for `event` on the user's machine. Rejects with the hook's failure, a restart or an abort. */
	/**
	 * `callKey`: a durable key for this hook call (`loopHookCallKey`), so a resumed or moved loop that issues the same call
	 * again reaches the user's machine's answer to it instead of running the hooks twice (senpi#5867). Absent: a new id.
	 */
	run(event: string, payload: JsonValue, signal?: AbortSignal, callKey?: string): Promise<JsonValue>;
	/** IDs of the calls still waiting for the user's machine. */
	waiting(): readonly string[];
	close(): void;
}

export interface LoopHookHostOptions {
	/** The loop host's end of the link to the user's machine. */
	readonly transport: Transport;
	/** The lane the link uses; one per session. */
	readonly lane: string;
	readonly mintId?: () => string;
	/**
	 * The session's current owner epoch, read at each transmission and stamped on the call (senpi#5916), so a call created
	 * at E and sent again after a reclaim carries E+1. Absent: calls carry none.
	 */
	readonly epoch?: () => number;
}

/** The hooks ran on the user's machine and failed there; the message is the hook's own. */
export class LoopHookFailedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LoopHookFailedError";
	}
}

/** The hand process that started the hooks was replaced before it answered; they may have run. Never re-run. */
export class LoopHookRestartedError extends Error {
	readonly uncertain = true;
	constructor(event: string) {
		super(`The user's machine restarted while it ran the ${event} hooks; they were not run again and may have run.`);
		this.name = "LoopHookRestartedError";
	}
}

/** The hand refused the call at the loop host's current epoch; it never ran (senpi#5916). */
export class LoopHookRefusedError extends Error {
	readonly reason: LoopHookRefusal;
	constructor(reason: LoopHookRefusal) {
		super(`The user's machine refused the hook call: ${reason}`);
		this.name = "LoopHookRefusedError";
		this.reason = reason;
	}
}

/** The loop host closed its link on purpose: a deliberate close, never a dead link (senpi#5867). */
export class LoopHookClosedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LoopHookClosedError";
	}
}

interface Pending {
	readonly call: LoopHookCall;
	startedBy?: string;
	/** The epoch this call was last re-issued at after a stale refusal: at most one re-issue per epoch. */
	reissuedAt?: number;
	readonly resolve: (result: JsonValue) => void;
	readonly reject: (error: Error) => void;
}

/** A hook call's durable key: the same for every loop that issues this hook of this turn in this session (senpi#5867). */
export function loopHookCallKey(session: string, turn: string, event: string, ordinal: number): string {
	return canonicalJson({ session, turn, event, ordinal });
}

export function createLoopHookHost(options: LoopHookHostOptions): LoopHookHost {
	const { transport, lane } = options;
	const mintId = options.mintId ?? (() => crypto.randomUUID());
	const pending = new Map<string, Pending>();
	let closed = false;

	const send = (call: LoopHookCall): void => {
		const stamped = options.epoch === undefined ? call : { ...call, epoch: options.epoch() };
		transport.send(lane, encodeLoopHookMessage(stamped)).catch((error: unknown) => {
			const reason = error instanceof Error ? error.message : String(error);
			settle(call.callId, (waiter) => waiter.reject(new Error(`The link to the user's machine closed: ${reason}`)));
		});
	};
	const settle = (callId: string, finish: (waiter: Pending) => void): void => {
		const waiter = pending.get(callId);
		if (waiter === undefined) return;
		pending.delete(callId);
		finish(waiter);
	};
	// A refusal echoing an epoch below ours is a stale re-delivery (the transport re-sends stored bytes after a reclaim):
	// send the same call again at our epoch, once per epoch. Any other refusal ends the call; it never ran.
	const onRefused = (refused: LoopHookRefused): void => {
		const waiter = pending.get(refused.callId);
		if (waiter === undefined) return;
		const current = options.epoch?.();
		if (current === undefined || refused.epoch >= current)
			return settle(refused.callId, (done) => done.reject(new LoopHookRefusedError(refused.reason)));
		if (waiter.reissuedAt === current) return;
		waiter.reissuedAt = current;
		send(waiter.call);
	};

	transport.onFrame((frame: TransportFrame) => {
		const message = decodeLoopHookMessage(frame.payload);
		if (message === undefined) return;
		switch (message.kind) {
			case "hook.started": {
				const waiter = pending.get(message.callId);
				if (waiter !== undefined) waiter.startedBy = message.instance;
				return;
			}
			case "hook.reply":
				return settle(message.callId, (waiter) => waiter.resolve(message.result));
			case "hook.failed":
				return settle(message.callId, (waiter) => waiter.reject(new LoopHookFailedError(message.error)));
			case "hook.refused":
				return onRefused(message);
			case "hook.restarted": {
				const waiter = pending.get(message.callId);
				if (waiter === undefined || waiter.startedBy === message.instance) return;
				return settle(message.callId, (stale) => stale.reject(new LoopHookRestartedError(stale.call.event)));
			}
			case "hook.hello":
				for (const waiter of [...pending.values()]) {
					if (waiter.startedBy === undefined) send(waiter.call);
					else if (waiter.startedBy !== message.instance)
						settle(waiter.call.callId, (stale) => stale.reject(new LoopHookRestartedError(stale.call.event)));
				}
				return;
			case "hook.call":
				return;
		}
	});

	return {
		run(event, payload, signal, callKey) {
			if (closed) return Promise.reject(new LoopHookClosedError("The loop-hook link is closed"));
			if (signal?.aborted) return Promise.reject(new Error("Operation aborted"));
			const call: LoopHookCall = {
				kind: "hook.call",
				callId: callKey ?? mintId(),
				event,
				payload,
			};
			const result = new Promise<JsonValue>((resolve, reject) => {
				pending.set(call.callId, { call, resolve, reject });
			});
			const onAbort = (): void => settle(call.callId, (waiter) => waiter.reject(new Error("Operation aborted")));
			signal?.addEventListener("abort", onAbort, { once: true });
			void result.then(
				() => signal?.removeEventListener("abort", onAbort),
				() => signal?.removeEventListener("abort", onAbort),
			);
			send(call);
			return result;
		},
		waiting: () => [...pending.keys()],
		close() {
			closed = true;
			for (const callId of [...pending.keys()])
				settle(callId, (waiter) =>
					waiter.reject(new LoopHookClosedError("The loop-hook link was closed before the hooks ran")),
				);
			transport.close();
		},
	};
}
