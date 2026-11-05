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
	| LoopHookHello
	| LoopHookStarted
	| LoopHookReply
	| LoopHookFailed
	| LoopHookRefused
	| LoopHookRestarted;

/** Loop host to hand: run the hooks for `event`. A re-send after a hand restart carries the same `callId`. */
export interface LoopHookCall {
	readonly kind: "hook.call";
	readonly callId: string;
	readonly event: string;
	readonly payload: JsonValue;
	/** The caller's owner epoch, stamped at each transmission (senpi#5916); the hand checks it against the tool scope's floor. */
	readonly epoch?: number;
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

/** The hooks ran and failed; the message is the hook's own. */
export interface LoopHookFailed {
	readonly kind: "hook.failed";
	readonly callId: string;
	readonly error: string;
}

export type LoopHookRefusal = "epoch_fenced" | "floor_missing" | "callId_taken";

/**
 * Hand to loop host: the call never ran and is not recorded (senpi#5916). `epoch` echoes the call's epoch, so a loop host
 * that owns a newer epoch can tell a stale re-delivery from a real refusal; `floor` is the scope's floor, absent when
 * `reason` is `floor_missing`.
 */
export type LoopHookRefused =
	| {
			readonly kind: "hook.refused";
			readonly callId: string;
			readonly reason: "floor_missing";
			readonly epoch: number;
	  }
	| {
			readonly kind: "hook.refused";
			readonly callId: string;
			readonly reason: "epoch_fenced" | "callId_taken";
			readonly epoch: number;
			readonly floor: number;
	  };

/** Hand to loop host: another hand process started this call and may have run it; `instance` is the current process. */
export interface LoopHookRestarted {
	readonly kind: "hook.restarted";
	readonly callId: string;
	readonly instance: string;
}

const KINDS: readonly LoopHookMessage["kind"][] = [
	"hook.call",
	"hook.hello",
	"hook.started",
	"hook.reply",
	"hook.failed",
	"hook.refused",
	"hook.restarted",
];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeLoopHookMessage(message: LoopHookMessage): Uint8Array {
	return encoder.encode(JSON.stringify(message));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isEpoch = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;

function decodeRefused(value: Record<string, unknown>): LoopHookRefused | undefined {
	const { callId, reason, epoch, floor } = value;
	if (!isId(callId) || !isEpoch(epoch)) return undefined;
	if (reason === "floor_missing")
		return floor === undefined ? { kind: "hook.refused", callId, reason, epoch } : undefined;
	if ((reason === "epoch_fenced" || reason === "callId_taken") && isEpoch(floor))
		return { kind: "hook.refused", callId, reason, epoch, floor };
	return undefined;
}

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
			if (!isId(value.callId) || !isId(value.event) || !("payload" in value)) return undefined;
			if (value.epoch !== undefined && !isEpoch(value.epoch)) return undefined;
			return {
				kind: "hook.call",
				callId: value.callId,
				event: value.event,
				payload: value.payload as JsonValue,
				...(value.epoch === undefined ? {} : { epoch: value.epoch as number }),
			};
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
		case "hook.refused":
			return decodeRefused(value);
		case "hook.restarted":
			return isId(value.callId) && isId(value.instance)
				? { kind: "hook.restarted", callId: value.callId, instance: value.instance }
				: undefined;
		default:
			return isId(value.callId) && typeof value.error === "string"
				? { kind: "hook.failed", callId: value.callId, error: value.error }
				: undefined;
	}
}
