import type { SessionEntry } from "../../../session-manager.ts";
import { TTSR_INJECTION_CUSTOM_TYPE } from "./types.ts";

export const TTSR_LOOP_STOPPED_ENTRY_TYPE = "ttsr-loop-stopped";
export const TTSR_LOOP_STOPPED_EVENT = "ttsr:loop-stopped";

export function ttsrLoopStoppedNotice(rule: string): string {
	return `The ${rule} stream rule flagged the reply again after its correction, so no further correction was sent. Send any message to continue.`;
}

function nudgedRules(entry: SessionEntry): readonly unknown[] {
	if (entry.type !== "custom_message" || entry.customType !== TTSR_INJECTION_CUSTOM_TYPE) return [];
	const details: unknown = entry.details;
	if (typeof details !== "object" || details === null || !("rules" in details)) return [];
	return Array.isArray(details.rules) ? details.rules : [];
}

/**
 * Whether this rule already sent its one corrective follow-up since the user's last message. Read from the
 * session, so a host that rebuilds the extension between turns cannot re-arm it (senpi#2967); the engine-wide
 * turn bound covers every other source.
 */
export function ruleAlreadyCorrected(entries: readonly SessionEntry[], rule: string): boolean {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "message" && entry.message.role === "user") return false;
		if (nudgedRules(entry).includes(rule)) return true;
	}
	return false;
}
