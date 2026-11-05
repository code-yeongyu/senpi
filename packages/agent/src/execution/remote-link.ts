import type { Transport, TransportFrame } from "../transport/transport.ts";
import { createPlaneServer, decodePlaneMessage, type PlaneHandler } from "./plane.ts";
import { createEpochGate } from "./remote-epoch-gate.ts";
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
	| { readonly kind: "closed" }
	/** The session's epoch never opened the lane (S35): a newer owner holds it, or the hand refused this sender. */
	| { readonly kind: "epoch_refused"; readonly reason: string };

export interface HandLink {
	dispatch(message: RemoteInvoke | RemoteFile, signal?: AbortSignal): Promise<HandReply>;
	/** The hand's `hello`, waiting at most `ms` for it (never past `signal`); `undefined` when none came. */
	hello(ms: number, signal?: AbortSignal): Promise<RemoteHello | undefined>;
	/**
	 * Opens `lane`'s epoch floor now, through the same gate the first dispatch uses (senpi#5932): `undefined` once the hand
	 * acked the floor at this epoch (or the session has no epoch), else the refusal; `aborted` when `signal` ends first.
	 */
	openScope(lane: string, signal?: AbortSignal): Promise<string | undefined>;
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
	epoch?: number,
): HandLink {
	const pending = new Map<string, Pending>();
	const stamp = epoch === undefined ? {} : { epoch };
	/** Messages handed to the transport: a hand's `hello` re-sends only these, never one still waiting on its floor. */
	const sent = new Set<string>();
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
		sent.delete(executionId);
		planes.parentEnded(executionId);
		waiter.resolve(reply);
	};
	const send = (lane: string, message: RemoteHandMessage): Promise<void> =>
		transport.send(lane, encodeRemoteMessage(message));
	const gate = epoch === undefined ? undefined : createEpochGate(epoch, (lane, floor) => send(lane, floor));
	/** Runs `go` once the lane's floor is acked at this epoch (at once without an epoch); a refusal ends the message. */
	const whenOpen = (lane: string, executionId: string, go: () => void): void => {
		if (gate === undefined) return go();
		void gate.open(lane).then((refusal) => {
			if (!pending.has(executionId)) return;
			if (refusal === undefined) return go();
			settle(executionId, { kind: "epoch_refused", reason: refusal });
		});
	};

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
			void send(frame.lane, { kind: "ack", executionId, ...stamp }).catch(() => undefined);
		if (message.kind === "hello") {
			announced = message;
			for (const waiter of [...helloWaiters]) waiter(message);
			gate?.resend();
			if (message.durable)
				for (const { message: waiting } of pending.values()) {
					if (!sent.has(waiting.executionId)) continue;
					whenOpen(
						waiting.scope.id,
						waiting.executionId,
						() => void send(waiting.scope.id, waiting).catch(() => undefined),
					);
				}
			return;
		}
		if (message.kind === "floor_ack" || message.kind === "floor_refused") return gate?.answer(frame.lane, message);
		if (message.kind === "settled") {
			settle(message.executionId, { kind: "settled", result: message.result });
			ack(message.executionId);
		} else if (message.kind === "terminal") {
			settle(message.executionId, { kind: "terminal", terminal: message });
			ack(message.executionId);
		} else if (message.kind === "refused") settle(message.executionId, { kind: "refused", reason: message.reason });
	});

	return {
		dispatch(unstamped, signal) {
			const message: RemoteInvoke | RemoteFile = { ...unstamped, ...stamp };
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
				const reached = sent.has(executionId);
				if (reached) void send(message.scope.id, { kind: "abort", executionId, ...stamp }).catch(() => undefined);
				settle(executionId, { kind: "aborted", sent: reached });
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			void replied.then(() => signal?.removeEventListener("abort", onAbort));
			whenOpen(message.scope.id, executionId, () => {
				sent.add(executionId);
				send(message.scope.id, message).catch((error: unknown) => {
					settle(executionId, {
						kind: "unreachable",
						reason: error instanceof Error ? error.message : String(error),
					});
				});
			});
			return replied;
		},
		openScope(lane, signal) {
			if (gate === undefined) return Promise.resolve(undefined);
			const opened = gate.open(lane);
			if (signal === undefined) return opened;
			if (signal.aborted) return Promise.resolve("aborted");
			const aborted = new Promise<string>((resolve) => signal.addEventListener("abort", () => resolve("aborted"), { once: true }));
			return Promise.race([opened, aborted]);
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
