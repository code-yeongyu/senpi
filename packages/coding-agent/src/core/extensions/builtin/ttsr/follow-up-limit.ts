import { isUserDirectedTurn } from "../../../engine-turn-limit.ts";
import type { SessionEntry } from "../../../session-manager.ts";
import { hasToolCall } from "./repetitive-turns-lane.ts";
import { TTSR_INJECTION_CUSTOM_TYPE } from "./types.ts";

export const TTSR_LOOP_STOPPED_ENTRY_TYPE = "ttsr-loop-stopped";
export const TTSR_LOOP_STOPPED_EVENT = "ttsr:loop-stopped";

/** Why a stream rule stopped the run instead of correcting it. */
export type TtsrLoopStopReason = "repeated-after-correction";

export interface TtsrLoopStopped {
	readonly rules: readonly string[];
	readonly reason: TtsrLoopStopReason;
	readonly at: number;
}

export function ttsrLoopStoppedNotice(rule: string): string {
	return `The ${rule} stream rule flagged the reply again after its correction, so no further correction was sent. Send any message to continue.`;
}

function nudgedRules(entry: SessionEntry): readonly unknown[] {
	if (entry.type !== "custom_message" || entry.customType !== TTSR_INJECTION_CUSTOM_TYPE) return [];
	const details: unknown = entry.details;
	if (typeof details !== "object" || details === null || !("rules" in details)) return [];
	return Array.isArray(details.rules) ? details.rules : [];
}

function stoppedRules(entry: SessionEntry): readonly unknown[] {
	if (entry.type !== "custom" || entry.customType !== TTSR_LOOP_STOPPED_ENTRY_TYPE) return [];
	const data: unknown = entry.data;
	if (typeof data !== "object" || data === null || !("rules" in data)) return [];
	return Array.isArray(data.rules) ? data.rules : [];
}

/**
 * A turn the person asked for: a typed message, or a `.` continue / continue-from-leaf / stop-resume, which are
 * recorded as hidden custom messages. After a stop the notice asks for "any message", so each of them must start a
 * fresh episode; counting only typed messages stopped a `.` continue at its first hit with no correction (senpi#4621).
 */
function isPersonTurn(entry: SessionEntry): boolean {
	if (entry.type === "message") return entry.message.role === "user";
	return entry.type === "custom_message" && isUserDirectedTurn(entry.customType);
}

/**
 * Whether this rule already sent its one corrective follow-up in the current episode. Read from the session, so a
 * host that rebuilds the extension between turns cannot re-arm it (senpi#2967). An episode ends at the person's next
 * turn, or when the agent acts again (calls a tool) after the correction: the correction worked, so a later
 * violation in a long autonomous run gets its own correction instead of a pause (senpi#4537).
 */
export function ruleAlreadyCorrected(entries: readonly SessionEntry[], rule: string): boolean {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (isPersonTurn(entry)) return false;
		if (entry.type === "message" && entry.message.role === "assistant" && hasToolCall(entry.message)) return false;
		if (nudgedRules(entry).includes(rule)) return true;
	}
	return false;
}

/** Whether this rule's stop was already recorded and shown since the person's last turn. */
export function loopStopAlreadyReported(entries: readonly SessionEntry[], rule: string): boolean {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (isPersonTurn(entry)) return false;
		if (stoppedRules(entry).includes(rule)) return true;
	}
	return false;
}
