import type { Transport, TransportFrame } from "../transport/transport.ts";
import { createPlaneServer, decodePlaneMessage, type PlaneHandler } from "./plane.ts";
import {
	decodeRemoteMessage,
	encodeRemoteMessage,
	type RemoteFile,
	type RemoteHandMessage,
	type RemoteHello,
	type RemoteInvoke,
	type RemoteTerminal,
	type RemoteToolResult,
} from "./remote-protocol.ts";

/** How a dispatched call or file operation ended, as the session saw it. */
export type HandReply =
	| { readonly kind: "settled"; readonly result: RemoteToolResult }
	| { readonly kind: "terminal"; readonly terminal: RemoteTerminal }
	| { readonly kind: "refused"; readonly reason: string }
	| { readonly kind: "aborted"; readonly sent: boolean }
	| { readonly kind: "unreachable"; readonly reason: string }
	| { readonly kind: "closed" };

export interface HandLink {
	dispatch(message: RemoteInvoke | RemoteFile, signal?: AbortSignal): Promise<HandReply>;
	/** The hand's `hello`, waiting at most `ms` for it (never past `signal`); `undefined` when none came. */
	hello(ms: number, signal?: AbortSignal): Promise<RemoteHello | undefined>;
	close(): void;
}

interface Pending {
	readonly message: RemoteInvoke | RemoteFile;
	readonly resolve: (reply: HandReply) => void;
}

/**
 * The session's end of the link to a hand (S27a, S40): every waiting call and file operation by execution ID, their
 * replies and acks, a forwarded abort, and the hand's `hello`. The only re-send is on a `hello` that says `durable`: a
 * hand with a record answers what it already holds, while a hand without one would run a re-sent call again or refuse
 * it as a duplicate, so its waiting calls are left to the paths that already end them.
 */
export function createHandLink(
	transport: Transport,
	planeHandlers: Readonly<Record<string, PlaneHandler>> = {},
	filePlanes: readonly string[] = [],
): HandLink {
	const pending = new Map<string, Pending>();
	// Nested requests (S31) are admitted only while their parent CALL is live on its lane. A pending file operation
	// (S40) hosts only the planes in `filePlanes` (a two-sided extension's forwarded tool events, S29); every other
	// plane under it is refused as if it had no live parent. An abort names no plane and reaches what was admitted.
	const planes = createPlaneServer({
		transport,
		planes: planeHandlers,
		liveLane: (executionId, plane) => {
			const waiting = pending.get(executionId)?.message;
			if (waiting?.kind === "invoke") return waiting.scope.id;
			if (waiting?.kind === "file" && (plane === undefined || filePlanes.includes(plane))) return waiting.scope.id;
			return undefined;
		},
	});
	let announced: RemoteHello | undefined;
	// A wait that ran out is remembered: later operations answer at once instead of each waiting again.
	let waitedOut = false;
	const helloWaiters = new Set<(hello: RemoteHello) => void>();

	const settle = (executionId: string, reply: HandReply): void => {
		const waiter = pending.get(executionId);
		if (waiter === undefined) return;
		pending.delete(executionId);
		planes.parentEnded(executionId);
		waiter.resolve(reply);
	};
	const send = (lane: string, message: RemoteHandMessage): Promise<void> =>
		transport.send(lane, encodeRemoteMessage(message));

	transport.onFrame((frame: TransportFrame) => {
		const nested = decodePlaneMessage(frame.payload);
		if (nested !== undefined) return planes.receive(frame.lane, nested);
		let message: RemoteHandMessage;
		try {
			message = decodeRemoteMessage(frame.payload);
		} catch {
			return;
		}
		const ack = (executionId: string): void =>
			void send(frame.lane, { kind: "ack", executionId }).catch(() => undefined);
		if (message.kind === "hello") {
			announced = message;
			for (const waiter of [...helloWaiters]) waiter(message);
			if (message.durable)
				for (const { message: waiting } of pending.values())
					void send(waiting.scope.id, waiting).catch(() => undefined);
			return;
		}
		if (message.kind === "settled") {
			settle(message.executionId, { kind: "settled", result: message.result });
			ack(message.executionId);
		} else if (message.kind === "terminal") {
			settle(message.executionId, { kind: "terminal", terminal: message });
			ack(message.executionId);
		} else if (message.kind === "refused") settle(message.executionId, { kind: "refused", reason: message.reason });
	});

	return {
		dispatch(message, signal) {
			const { executionId } = message;
			const replied = new Promise<HandReply>((resolve) => {
				pending.set(executionId, { message, resolve });
			});
			if (signal?.aborted) {
				settle(executionId, { kind: "aborted", sent: false });
				return replied;
			}
			const onAbort = (): void => {
				if (!pending.has(executionId)) return;
				void send(message.scope.id, { kind: "abort", executionId }).catch(() => undefined);
				settle(executionId, { kind: "aborted", sent: true });
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			void replied.then(() => signal?.removeEventListener("abort", onAbort));
			send(message.scope.id, message).catch((error: unknown) => {
				settle(executionId, {
					kind: "unreachable",
					reason: error instanceof Error ? error.message : String(error),
				});
			});
			return replied;
		},
		hello(ms, signal) {
			if (announced !== undefined || waitedOut || signal?.aborted) return Promise.resolve(announced);
			return new Promise((resolve) => {
				const done = (hello: RemoteHello | undefined): void => {
					clearTimeout(timer);
					helloWaiters.delete(done);
					signal?.removeEventListener("abort", onAbort);
					resolve(hello);
				};
				const onAbort = (): void => done(undefined);
				const timer = setTimeout(() => {
					waitedOut = true;
					done(undefined);
				}, ms);
				helloWaiters.add(done);
				signal?.addEventListener("abort", onAbort, { once: true });
			});
		},
		close() {
			for (const executionId of [...pending.keys()]) settle(executionId, { kind: "closed" });
			transport.close();
		},
	};
}
