import type { JsonValue } from "@earendil-works/pi-ai";

/**
 * The loop-hook link (brain/hand split S33, decisions C8, K5, K7): when the loop runs away from the user's machine, the
 * loop host asks that machine to run the user's loop hooks (shell hooks and the hook halves of extensions) and waits for
 * the result before it builds the provider request. Every message travels on one lane, so a hook's `started` reaches
 * the loop host before the `hello` of a hand process that replaced the one that started it, PROVIDED the hand's
 * transport endpoint outlives the hand process: `started` is in the endpoint's send window once `send` resolves, not yet
 * acknowledged, and the transport delivers it only while both endpoints live. If the endpoint dies with the process and
 * takes an unacknowledged `started` with it, the loop host never learns the call began and sends it again to the
 * replacement, so a hook that had run runs a second time. At-most-once dispatch therefore holds only on a hand whose
 * endpoint is the machine's long-lived link endpoint, not one owned by the hand process.
 *
 * Ordering is per SESSION, not per lane: a lane may carry many sessions (a hand serves every scope's sessions on one
 * lane), and the hand names each call's session (`serveLoopHooks`'s `sessionOf`). It runs one session's calls one at a
 * time, in the order they arrived; calls of different sessions run side by side, so one session's stuck call holds no
 * other. A call's hooks start once its session's previous call has settled, a cancelled call's included. How long a
 * running call takes is bounded only where its runner bounds its handlers (on a senpi hand: lifecycle and compaction
 * handlers have a session's per-handler cap unless it is turned off, while `input`, `before_agent_start` and
 * `before_provider_request` handlers have none, as in a local session). The wait for a turn is always bounded, per call
 * ahead rather than in total: a call whose call ahead does not settle within `queueWaitMs` (the bound restarts each time
 * one settles, so a slow queue that keeps moving never trips it) answers `hook.failed` with reason `queue_timeout` (the loop host raises
 * `LoopHookQueueTimeoutError`) without starting its hooks. The hand reads the lane meanwhile, so `hook.cancel` reaches
 * the call it names: a running call's signal aborts, and a waiting call answers `hook.failed` with reason `cancelled`
 * without starting its hooks.
 */
export type LoopHookMessage =
	| LoopHookCall
	| LoopHookCancel
	| LoopHookHello
	| LoopHookStarted
	| LoopHookReply
	| LoopHookFailed;

/** Loop host to hand: run the hooks for `event`. A re-send after a hand restart carries the same `callId`. */
export interface LoopHookCall {
	readonly kind: "hook.call";
	readonly callId: string;
	readonly event: string;
	readonly payload: JsonValue;
}

/**
 * Loop host to hand: the caller stopped waiting for `callId`, so the hooks still running for it are told to stop (their
 * signal aborts). Same lane as the call, so it never overtakes it. Nothing answers it; the call's own answer, if the hooks
 * still send one, is dropped by the host.
 */
export interface LoopHookCancel {
	readonly kind: "hook.cancel";
	readonly callId: string;
}

/** Hand to loop host, once per hand process, before it serves anything. */
export interface LoopHookHello {
	readonly kind: "hook.hello";
	readonly instance: string;
}

/** Hand to loop host, sent before the hooks run: from here on the call may have had effects. */
export interface LoopHookStarted {
	readonly kind: "hook.started";
	readonly callId: string;
	readonly instance: string;
}

export interface LoopHookReply {
	readonly kind: "hook.reply";
	readonly callId: string;
	readonly result: JsonValue;
}

/** Why a call ended without running its hooks: cancelled while it waited its turn, or waited past the cap. */
export type LoopHookRefusal = "cancelled" | "queue_timeout";
const REFUSALS: readonly LoopHookRefusal[] = ["cancelled", "queue_timeout"];

/**
 * The hooks ran and failed, and the message is the hook's own; or, with `reason`, the call ended without running them
 * (no `hook.started` was sent for it).
 */
export interface LoopHookFailed {
	readonly kind: "hook.failed";
	readonly callId: string;
	readonly error: string;
	readonly reason?: LoopHookRefusal;
}

const KINDS: readonly LoopHookMessage["kind"][] = [
	"hook.call",
	"hook.cancel",
	"hook.hello",
	"hook.started",
	"hook.reply",
	"hook.failed",
];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeLoopHookMessage(message: LoopHookMessage): Uint8Array {
	return encoder.encode(JSON.stringify(message));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Parses one frame payload as a loop-hook message; anything else is `undefined`. */
export function decodeLoopHookMessage(payload: Uint8Array): LoopHookMessage | undefined {
	let value: unknown;
	try {
		value = JSON.parse(decoder.decode(payload));
	} catch {
		return undefined;
	}
	if (!isRecord(value) || !KINDS.includes(value.kind as LoopHookMessage["kind"])) return undefined;
	switch (value.kind) {
		case "hook.call":
			return isId(value.callId) && isId(value.event) && "payload" in value
				? { kind: "hook.call", callId: value.callId, event: value.event, payload: value.payload as JsonValue }
				: undefined;
		case "hook.cancel":
			return isId(value.callId) ? { kind: "hook.cancel", callId: value.callId } : undefined;
		case "hook.hello":
			return isId(value.instance) ? { kind: "hook.hello", instance: value.instance } : undefined;
		case "hook.started":
			return isId(value.callId) && isId(value.instance)
				? { kind: "hook.started", callId: value.callId, instance: value.instance }
				: undefined;
		case "hook.reply":
			return isId(value.callId) && "result" in value
				? { kind: "hook.reply", callId: value.callId, result: value.result as JsonValue }
				: undefined;
		default: {
			if (!isId(value.callId) || typeof value.error !== "string") return undefined;
			const reason = REFUSALS.find((refusal) => refusal === value.reason);
			return {
				kind: "hook.failed",
				callId: value.callId,
				error: value.error,
				...(reason === undefined ? {} : { reason }),
			};
		}
	}
}
