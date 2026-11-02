import { CONTINUE_FROM_LEAF_CUSTOM_TYPE } from "./continue-from-leaf.ts";
import { MANUAL_CONTINUE_CUSTOM_TYPE } from "./manual-continue.ts";
import type { HistoryReducer } from "./session-history-reduce.ts";
import type { SessionEntry } from "./session-manager.ts";
import { STOP_RESUME_CUSTOM_TYPE } from "./stop-resume-directive.ts";

export const MAX_ENGINE_TURNS_PER_USER_INPUT = 0;
export const MAX_ENGINE_TURNS_PER_RESUME_WINDOW = 8;
export const MAX_TOOL_FREE_ENGINE_TURNS_PER_WINDOW = 12;
export const ENGINE_TURN_WINDOW_MS = 60_000;

/** Appended when the engine starts a turn no user message asked for; the limits count these. */
export const ENGINE_TURN_START_ENTRY_TYPE = "engine-turn-start";
export const ENGINE_TURN_LIMIT_ENTRY_TYPE = "engine-turn-limit";
export const ENGINE_TURN_LIMIT_EVENT = "engine:turn-limit";

export type EngineTurnStopReason = "per-user-input" | "tool-free-rate" | "resume-window";

/** A limit of 0 turns that limit off. */
export interface EngineTurnLimits {
	readonly maxPerUserInput: number;
	readonly maxToolFreePerMinute: number;
	readonly maxPerResumeWindow?: number;
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
	if (stop.reason === "resume-window") {
		return `Paused: the agent started ${stop.sinceUserInput} turns on its own in this resume window. Send any message to continue.`;
	}
	return stop.reason === "per-user-input"
		? `Paused: the agent started ${stop.sinceUserInput} turns on its own since your last message. Send any message to continue.`
		: `Paused: the agent started ${stop.toolFreeInWindow} turns on its own in the last minute without doing any work. Send any message to continue.`;
}

/** A `.` manual continue or a continue-from-leaf is the user's own request, not an automatic turn. */
export function isUserDirectedTurn(customType: string): boolean {
	return (
		customType === MANUAL_CONTINUE_CUSTOM_TYPE ||
		customType === CONTINUE_FROM_LEAF_CUSTOM_TYPE ||
		customType === STOP_RESUME_CUSTOM_TYPE
	);
}

/** Recovering an interrupted run is not a new message that resets the unattended turn budget. */
export function resetsEngineTurnHistory(customType: string, details?: unknown): boolean {
	return (
		isUserDirectedTurn(customType) &&
		!(
			customType === STOP_RESUME_CUSTOM_TYPE &&
			(details as { resumeCause?: unknown } | undefined)?.resumeCause === "interrupted"
		)
	);
}

function isUserMessage(entry: SessionEntry): boolean {
	if (entry.type === "custom_message") return resetsEngineTurnHistory(entry.customType, entry.details);
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

/** The session's engine turns since the user's last message, in order: when each started and whether its reply called a tool. */
export interface EngineTurnHistory {
	readonly starts: EngineTurnStartRecord[];
}

/**
 * Folds the session history into `EngineTurnHistory` (senpi#2537): read once per load and extended per append, so a
 * stream of engine turns never materializes a compacted session's whole history. A tool call marks the latest start.
 */
export const engineTurnHistory: HistoryReducer<EngineTurnHistory> = {
	initial: () => ({ starts: [] }),
	add: (history, entry) => {
		if (isUserMessage(entry)) return { starts: [] };
		if (isEngineTurnStart(entry)) history.starts.push({ at: Date.parse(entry.timestamp), toolUsed: false });
		else if (callsATool(entry)) {
			const latest = history.starts.at(-1);
			if (latest !== undefined) latest.toolUsed = true;
		}
		return history;
	},
};

/**
 * Whether one more engine-started turn may begin. Only turns since the user's last message count, so any
 * message the user sends lifts a pause at once. Read from the session entries, so a host that rebuilds
 * extensions or reopens the session between turns is bounded too (senpi#2967). The per-minute breaker counts
 * only engine turns whose reply called no tool: measured goal runs never exceed it, while every observed
 * runaway has that shape.
 */
export function engineTurnStop(
	history: EngineTurnHistory,
	now: number,
	limits: EngineTurnLimits,
	inProcess: readonly EngineTurnStartRecord[] = [],
): EngineTurnStop | null {
	let sinceUserInput = history.starts.length;
	let toolFreeInWindow = 0;
	for (const start of history.starts) {
		if (now - start.at >= ENGINE_TURN_WINDOW_MS) continue;
		if (!start.toolUsed) toolFreeInWindow += 1;
	}
	// The session record and this process's own record: the larger count wins, so a file that refuses writes
	// cannot lift the bound for the process that is running the turns.
	sinceUserInput = Math.max(sinceUserInput, inProcess.length);
	toolFreeInWindow = Math.max(
		toolFreeInWindow,
		inProcess.filter((record) => !record.toolUsed && now - record.at < ENGINE_TURN_WINDOW_MS).length,
	);
	const resumeLimit = limits.maxPerResumeWindow ?? 0;
	if (resumeLimit > 0 && sinceUserInput >= resumeLimit) {
		return { reason: "resume-window", sinceUserInput, toolFreeInWindow };
	}
	if (limits.maxPerUserInput > 0 && sinceUserInput >= limits.maxPerUserInput) {
		return { reason: "per-user-input", sinceUserInput, toolFreeInWindow };
	}
	if (limits.maxToolFreePerMinute > 0 && toolFreeInWindow >= limits.maxToolFreePerMinute) {
		return { reason: "tool-free-rate", sinceUserInput, toolFreeInWindow };
	}
	return null;
}
