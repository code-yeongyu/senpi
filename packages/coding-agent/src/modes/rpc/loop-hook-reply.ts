import type { JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionRunner } from "../../core/extensions/runner.ts";
import type { LoopHookCall, LoopHookEffects } from "./loop-hook-call.ts";

/**
 * A reply part that has no JSON form (a `Map`, a `Date`, a function, a non-finite number, a hole in an array): the
 * loop-hook link carries JSON only, so the call is refused rather than replying with a value that lost part of what the
 * handler returned. `undefined` object fields are absent fields, as in JSON.
 */
class LoopHookReplyError extends Error {
	override readonly name = "LoopHookReplyError";
}

function describe(value: unknown): string {
	if (typeof value === "number") return "a non-finite number";
	if (typeof value !== "object" || value === null) return `a ${typeof value}`;
	const prototype: unknown = Object.getPrototypeOf(value);
	const name = typeof prototype === "object" && prototype !== null ? prototype.constructor.name : "";
	return name === "" ? "an object without a plain prototype" : `a ${name}`;
}

function assertWireJson(event: string, value: unknown, path: string): asserts value is JsonValue {
	const refuse = (at: string, part: unknown): never => {
		throw new LoopHookReplyError(
			`${event} reply has no JSON form at ${at === "" ? "its root" : at} (${describe(part)})`,
		);
	};
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) refuse(path, value);
		return;
	}
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			if (item === undefined) refuse(`${path}[${index}]`, item);
			assertWireJson(event, item, `${path}[${index}]`);
		}
		return;
	}
	if (typeof value !== "object") return refuse(path, value);
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) refuse(path, value);
	for (const [key, field] of Object.entries(value))
		if (field !== undefined) assertWireJson(event, field, path === "" ? key : `${path}.${key}`);
}

/**
 * Runs one forwarded event's handlers as `call`'s dispatch and builds its reply: their merged result, what they sent,
 * notified and wrote (session port), late messages dropped, their failures, which are reported, not thrown, as in a
 * session, and the hand's new `wants` when a subscription changed it (review M1). The runner is shared with tool calls, so only failures inside this call's own async context are its own.
 */
export async function loopHookReply(
	event: string,
	run: {
		readonly runner: ExtensionRunner;
		readonly call: LoopHookCall;
		readonly effects: LoopHookEffects;
		/** The hand's `wants` when it changed since it was last reported, read after the handlers ran. */
		readonly wants: {
			changed(): readonly string[] | undefined;
			/** Marks the set reported: only once this reply passed the wire check and the loop still waits for it. */
			reported(wants: readonly string[]): void;
		};
		/** Whether the loop cancelled the call: its reply is then dropped, so a change it carries stays pending. */
		readonly cancelled: () => boolean;
	},
	dispatch: () => Promise<object | undefined>,
): Promise<JsonValue> {
	const { runner, call, effects } = run;
	const own = call.current();
	const errors: { extensionPath: string; event: string; error: string }[] = [];
	const stop = runner.onError(({ extensionPath, event: failed, error }) => {
		if (own !== undefined && call.current() === own) errors.push({ extensionPath, event: failed, error });
	});
	try {
		const result = await dispatch();
		const { sent, notices, entries, userMessages } = effects;
		const wants = run.wants.changed();
		const reply = {
			...result,
			...(sent.length > 0 ? { sent } : {}),
			...(notices.length > 0 ? { notices } : {}),
			...(entries.length > 0 ? { entries } : {}),
			...(userMessages.length > 0 ? { userMessages } : {}),
			...(effects.dropped > 0 ? { droppedLate: effects.dropped } : {}),
			...(errors.length > 0 ? { errors } : {}),
			...(wants === undefined ? {} : { wants }),
		};
		assertWireJson(event, reply, "");
		// A copy: a handler that keeps a reference to what it returned cannot change the reply after it was sent.
		const wire = JSON.parse(JSON.stringify(reply)) as JsonValue;
		// The reply now goes to the link (which redelivers it to a repeated call), so the change it carries is reported.
		if (wants !== undefined && !run.cancelled()) run.wants.reported(wants);
		return wire;
	} finally {
		stop();
	}
}
