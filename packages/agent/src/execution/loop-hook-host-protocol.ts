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
 */
export type LoopHookMessage =
	| LoopHookCall
	| LoopHookCancel
	| LoopHookHello
	| LoopHookStarted
	| LoopHookReply
	| LoopHookAck
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
 * still send one, is dropped by the host. The host settles each call once, so a cancel the hand receives after it replied
 * means that reply was dropped: the hand aborts the hooks' signal then too, and their effects reach the loop another way.
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

/**
 * Loop host to hand: the host consumed the reply to `callId`, so no cancel will follow it and the hand stops keeping the
 * call's signal for one (#6808 review L1). A host that sends none leaves the hand keeping it, as it keeps its answers.
 */
export interface LoopHookAck {
	readonly kind: "hook.ack";
	readonly callId: string;
}

/** The hooks ran and failed; the message is the hook's own. */
export interface LoopHookFailed {
	readonly kind: "hook.failed";
	readonly callId: string;
	readonly error: string;
}

const KINDS: readonly LoopHookMessage["kind"][] = [
	"hook.call",
	"hook.cancel",
	"hook.hello",
	"hook.started",
	"hook.reply",
	"hook.ack",
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
		case "hook.ack":
			return isId(value.callId) ? { kind: "hook.ack", callId: value.callId } : undefined;
		default:
			return isId(value.callId) && typeof value.error === "string"
				? { kind: "hook.failed", callId: value.callId, error: value.error }
				: undefined;
	}
}
