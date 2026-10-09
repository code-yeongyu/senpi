import { CONTINUE_FROM_LEAF_CUSTOM_TYPE } from "./continue-from-leaf.ts";
import { MANUAL_CONTINUE_CUSTOM_TYPE } from "./manual-continue.ts";
import type { SessionEntry } from "./session-manager.ts";

export const MAX_ENGINE_TURNS_PER_USER_INPUT = 150;
export const MAX_TOOL_FREE_ENGINE_TURNS_PER_WINDOW = 12;
export const ENGINE_TURN_WINDOW_MS = 60_000;

/** Appended when the engine starts a turn no user message asked for; the limits count these. */
export const ENGINE_TURN_START_ENTRY_TYPE = "engine-turn-start";
export const ENGINE_TURN_LIMIT_ENTRY_TYPE = "engine-turn-limit";
export const ENGINE_TURN_LIMIT_EVENT = "engine:turn-limit";

export type EngineTurnStopReason = "per-user-input" | "tool-free-rate";

/** A limit of 0 turns that limit off. */
export interface EngineTurnLimits {
	readonly maxPerUserInput: number;
	readonly maxToolFreePerMinute: number;
}

/** An engine turn this process started since the user's last message, kept even when the session file refuses writes. */
export interface EngineTurnStartRecord {
	readonly at: number;
	toolUsed: boolean;
}

export interface EngineTurnStop {
	readonly reason: EngineTurnStopReason;
	readonly sinceUserInput: number;
	readonly toolFreeInWindow: number;
}

export function engineTurnLimitNotice(stop: EngineTurnStop): string {
	return stop.reason === "per-user-input"
		? `Paused: the agent started ${stop.sinceUserInput} turns on its own since your last message. Send any message to continue.`
		: `Paused: the agent started ${stop.toolFreeInWindow} turns on its own in the last minute without doing any work. Send any message to continue.`;
}

/** A `.` manual continue or a continue-from-leaf is the user's own request, not an automatic turn. */
export function isUserDirectedTurn(customType: string): boolean {
	return customType === MANUAL_CONTINUE_CUSTOM_TYPE || customType === CONTINUE_FROM_LEAF_CUSTOM_TYPE;
}

function isUserMessage(entry: SessionEntry): boolean {
	if (entry.type === "custom_message") return isUserDirectedTurn(entry.customType);
	return entry.type === "message" && entry.message.role === "user";
}

function isEngineTurnStart(entry: SessionEntry): boolean {
	return entry.type === "custom" && entry.customType === ENGINE_TURN_START_ENTRY_TYPE;
}

function callsATool(entry: SessionEntry): boolean {
	return (
		entry.type === "message" &&
		entry.message.role === "assistant" &&
		entry.message.content.some((block) => block.type === "toolCall")
	);
}

/**
 * Whether one more engine-started turn may begin. Only turns since the user's last message count, so any
 * message the user sends lifts a pause at once. Read from the session entries, so a host that rebuilds
 * extensions or reopens the session between turns is bounded too (senpi#2967). The per-minute breaker counts
 * only engine turns whose reply called no tool: measured goal runs never exceed it, while every observed
 * runaway has that shape.
 */
export function engineTurnStop(
	entries: readonly SessionEntry[],
	now: number,
	limits: EngineTurnLimits,
	inProcess: readonly EngineTurnStartRecord[] = [],
): EngineTurnStop | null {
	let start = entries.length;
	while (start > 0 && !isUserMessage(entries[start - 1])) start -= 1;
	let sinceUserInput = 0;
	let toolFreeInWindow = 0;
	for (let index = start; index < entries.length; index++) {
		const entry = entries[index];
		if (!isEngineTurnStart(entry)) continue;
		sinceUserInput += 1;
		if (now - Date.parse(entry.timestamp) >= ENGINE_TURN_WINDOW_MS) continue;
		let toolUsed = false;
		for (let next = index + 1; next < entries.length && !isEngineTurnStart(entries[next]); next++) {
			if (callsATool(entries[next])) {
				toolUsed = true;
				break;
			}
		}
		if (!toolUsed) toolFreeInWindow += 1;
	}
	// The session record and this process's own record: the larger count wins, so a file that refuses writes
	// cannot lift the bound for the process that is running the turns.
	sinceUserInput = Math.max(sinceUserInput, inProcess.length);
	toolFreeInWindow = Math.max(
		toolFreeInWindow,
		inProcess.filter((record) => !record.toolUsed && now - record.at < ENGINE_TURN_WINDOW_MS).length,
	);
	if (limits.maxPerUserInput > 0 && sinceUserInput >= limits.maxPerUserInput) {
		return { reason: "per-user-input", sinceUserInput, toolFreeInWindow };
	}
	if (limits.maxToolFreePerMinute > 0 && toolFreeInWindow >= limits.maxToolFreePerMinute) {
		return { reason: "tool-free-rate", sinceUserInput, toolFreeInWindow };
	}
	return null;
}
