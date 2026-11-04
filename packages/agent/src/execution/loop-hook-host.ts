import type { JsonValue } from "@earendil-works/pi-ai";
import type { Transport, TransportFrame } from "../transport/transport.ts";
import { decodeLoopHookMessage, encodeLoopHookMessage, type LoopHookCall } from "./loop-hook-host-protocol.ts";

/**
 * The loop host's side of the loop-hook link (brain/hand split S33; decisions C8, K5, K7). When the loop runs on a
 * machine that is not the user's (a hosted loop), the user's loop hooks run on the user's machine: `run` sends one hook
 * call there and resolves with its result, and the caller builds the provider request only from that result, so no
 * provider request leaves without it. While that machine is unreachable the call simply waits (the work is paused), and
 * the transport delivers it once the machine is back, so it resumes exactly once. A fused or split-local session never
 * builds this host: its hooks run in its own process, as today.
 *
 * Restarts: a call the previous hand process never started is sent again, with the same ID, to the new one. A call it
 * had started (and so may have run) is never sent again: it ends with {@link LoopHookRestartedError}.
 */
export interface LoopHookHost {
	/** Runs the user's hooks for `event` on the user's machine. Rejects with the hook's failure, a restart or an abort. */
	run(event: string, payload: JsonValue, signal?: AbortSignal): Promise<JsonValue>;
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

interface Pending {
	readonly call: LoopHookCall;
	startedBy?: string;
	readonly resolve: (result: JsonValue) => void;
	readonly reject: (error: Error) => void;
}

export function createLoopHookHost(options: LoopHookHostOptions): LoopHookHost {
	const { transport, lane } = options;
	const mintId = options.mintId ?? (() => crypto.randomUUID());
	const pending = new Map<string, Pending>();
	let closed = false;

	const send = (call: LoopHookCall): void => {
		transport.send(lane, encodeLoopHookMessage(call)).catch((error: unknown) => {
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
		run(event, payload, signal) {
			if (closed) return Promise.reject(new Error("The loop-hook link is closed"));
			if (signal?.aborted) return Promise.reject(new Error("Operation aborted"));
			const call: LoopHookCall = { kind: "hook.call", callId: mintId(), event, payload };
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
				settle(callId, (waiter) => waiter.reject(new Error("The loop-hook link was closed before the hooks ran")));
			transport.close();
		},
	};
}
