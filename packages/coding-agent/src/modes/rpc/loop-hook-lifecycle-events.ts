import type {
	SessionHoldChangedEvent,
	SessionHoldRecord,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../core/extensions/types.ts";
import type { SessionControlWakeReason } from "../../core/extensions/session-control-types.ts";
import {
	carriedSessionOf,
	isBoolean,
	isNumber,
	isOneOf,
	isOptional,
	isRecord,
	isString,
	isStrings,
	loopHookFamily,
	malformed,
	forwarded,
} from "./loop-hook-payloads.ts";
import { isAgentMessages } from "./agent-message-schema.ts";

// The session and agent lifecycle a hosted loop forwards (senpi#5898): start, park/resume, holds, wakes, abort,
// shutdown, and an agent run's start, end and settle. Each handler returns nothing; its effects ride the reply.

const SESSION_START_REASONS = [
	"startup",
	"reload",
	"new",
	"resume",
	"fork",
] as const satisfies readonly SessionStartEvent["reason"][];
const SHUTDOWN_REASONS = [
	"quit",
	"reload",
	"new",
	"resume",
	"fork",
] as const satisfies readonly SessionShutdownEvent["reason"][];
const HOLD_CHANGES = ["paused", "resumed"] as const satisfies readonly SessionHoldChangedEvent["change"][];
const WAKE_REASONS = [
	"idle",
	"submission",
	"draft_cleared",
	"command",
	"inbox",
	"emitted",
	"continue",
] as const satisfies readonly SessionControlWakeReason[];

const isHold = (value: unknown): value is SessionHoldRecord =>
	isRecord(value) && isString(value.kind) && isString(value.key);

const isWakeReasons = (value: unknown): value is SessionControlWakeReason[] =>
	Array.isArray(value) && value.every((reason) => isOneOf(reason, WAKE_REASONS));

const isCounts = (value: unknown): value is Record<string, number> =>
	isRecord(value) && Object.values(value).every(isNumber);

export const LIFECYCLE_LOOP_HOOKS = loopHookFamily({
	session_start: ({ reason, previousSessionFile }) => {
		if (!isOneOf(reason, SESSION_START_REASONS) || !isOptional(previousSessionFile, isString))
			throw malformed("session_start");
		return forwarded({
			type: "session_start",
			reason,
			...(previousSessionFile === undefined ? {} : { previousSessionFile }),
		});
	},
	session_shutdown: ({ reason, targetSessionFile }) => {
		if (!isOneOf(reason, SHUTDOWN_REASONS) || !isOptional(targetSessionFile, isString))
			throw malformed("session_shutdown");
		return forwarded({
			type: "session_shutdown",
			reason,
			...(targetSessionFile === undefined ? {} : { targetSessionFile }),
		});
	},
	session_parked: () => forwarded({ type: "session_parked" }),
	session_resumed: () => forwarded({ type: "session_resumed" }),
	session_abort: () => forwarded({ type: "session_abort" }),
	session_info_changed: (payload) => {
		// `name` is absent when the session has none, as the local event's `name: undefined`.
		if (!isOptional(payload.name, isString)) throw malformed("session_info_changed");
		return forwarded({ type: "session_info_changed", name: payload.name });
	},
	session_hold_changed: ({ change, pauseSeq, holds }) => {
		if (!isOneOf(change, HOLD_CHANGES) || !isNumber(pauseSeq) || !Array.isArray(holds) || !holds.every(isHold))
			throw malformed("session_hold_changed");
		return forwarded({ type: "session_hold_changed", change, pauseSeq, holds });
	},
	held_wakes_released: ({ sources }) => {
		if (!isCounts(sources)) throw malformed("held_wakes_released");
		return forwarded({ type: "held_wakes_released", sources });
	},
	session_control_wake: ({ reason, reasons, delivery_ids }) => {
		if (!isOneOf(reason, WAKE_REASONS) || !isWakeReasons(reasons) || !isOptional(delivery_ids, isStrings))
			throw malformed("session_control_wake");
		return forwarded({
			type: "session_control_wake",
			reason,
			reasons,
			...(delivery_ids === undefined ? {} : { delivery_ids }),
		});
	},
	agent_start: () => forwarded({ type: "agent_start" }),
	agent_end: (payload) => {
		const { messages, aborted } = payload;
		const carried = carriedSessionOf(payload);
		if (!isAgentMessages(messages) || !isOptional(aborted, isBoolean) || carried === null)
			throw malformed("agent_end");
		return {
			...forwarded({ type: "agent_end", messages, ...(aborted === undefined ? {} : { aborted }) }),
			// An agent_end ends the loop's turn: a Stop held for the hand's background work runs after this call, with the
			// session it carried, and its writes ride the session's next reply.
			binding: { carried, endsTurn: true },
		};
	},
	agent_settled: ({ fallbackExhausted }) => {
		if (fallbackExhausted === undefined) return forwarded({ type: "agent_settled" });
		if (!isRecord(fallbackExhausted)) throw malformed("agent_settled");
		const { resumeAt } = fallbackExhausted;
		if (!isOptional(resumeAt, isNumber)) throw malformed("agent_settled");
		return forwarded({
			type: "agent_settled",
			fallbackExhausted: resumeAt === undefined ? {} : { resumeAt },
		});
	},
});
