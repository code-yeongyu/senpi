/**
 * A thread's settled (Done) flag, durable in its own session file beside the archived flag (`session-archived.ts`).
 *
 * The flag is a `custom` entry of type `session_settled` with `data: { settled, by?, at, sessionId }`. The newest
 * entry naming the session wins; a session that never wrote one is not settled. `by` mirrors the desktop app's
 * `ThreadSettledBy` (how the thread reached Done), so every device that lists the session reads the same value. Like
 * the archived flag it counts only for the session it names, so a fork or clone starts not settled, and the session
 * manager keeps it current on every append and index rebuild (`getSettled()`) without materializing the history.
 */
import { sessionMarkerData } from "./session-archived.ts";
import type { SessionEntry, SessionManager } from "./session-manager.ts";

const SESSION_SETTLED_CUSTOM_TYPE = "session_settled";

/** The desktop app's `ThreadSettledBy`: who or what settled the thread. */
export type ThreadSettledBy =
	| { readonly kind: "user" }
	| { readonly kind: "agent"; readonly threadId?: string; readonly threadTitle?: string }
	| { readonly kind: "pr-merged" | "pr-closed"; readonly pullRequestNumber?: number }
	| { readonly kind: "inactivity"; readonly days: number };

export interface SessionSettled {
	readonly settled: boolean;
	readonly by?: ThreadSettledBy;
}

/** The fields a listing row, a status record, a worker snapshot and the change event carry. */
export interface SettledFields {
	readonly settled: boolean;
	readonly settledBy?: ThreadSettledBy;
}

export const NOT_SETTLED: SessionSettled = { settled: false };

const BY_REFUSAL =
	"set_session_settled: by must be a ThreadSettledBy (kind user, agent, pr-merged, pr-closed or inactivity, with its fields)";

function isIntegerAtLeast(value: unknown, minimum: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= minimum;
}

/** A trimmed non-empty string, undefined when absent, or null when present but not one. */
function optionalText(value: unknown): string | undefined | null {
	if (value === undefined) return undefined;
	const text = typeof value === "string" ? value.trim() : "";
	return text === "" ? null : text;
}

/** Decodes `value` the way the desktop's schema does: strings trimmed, fields the kind does not carry dropped. */
function parseThreadSettledBy(value: unknown): ThreadSettledBy | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const by = value as Readonly<Record<string, unknown>>;
	const kind = by.kind;
	switch (kind) {
		case "user":
			return { kind };
		case "agent": {
			const threadId = optionalText(by.threadId);
			const threadTitle = optionalText(by.threadTitle);
			if (threadId === null || threadTitle === null) return undefined;
			return {
				kind,
				...(threadId !== undefined ? { threadId } : {}),
				...(threadTitle !== undefined ? { threadTitle } : {}),
			};
		}
		case "pr-merged":
		case "pr-closed": {
			const pullRequestNumber = by.pullRequestNumber;
			if (pullRequestNumber === undefined) return { kind };
			return isIntegerAtLeast(pullRequestNumber, 1) ? { kind, pullRequestNumber } : undefined;
		}
		case "inactivity": {
			const days = by.days;
			return isIntegerAtLeast(days, 0) ? { kind, days } : undefined;
		}
		default:
			return undefined;
	}
}

/** The arguments of `set_session_settled`; `by` is validated whenever present and dropped when unsettling. */
export function parseSessionSettled(command: {
	readonly settled?: unknown;
	readonly by?: unknown;
}): { readonly ok: true; readonly value: SessionSettled } | { readonly ok: false; readonly error: string } {
	if (typeof command.settled !== "boolean")
		return { ok: false, error: "set_session_settled: settled must be a boolean" };
	if (command.by === undefined) return { ok: true, value: { settled: command.settled } };
	const by = parseThreadSettledBy(command.by);
	if (by === undefined) return { ok: false, error: BY_REFUSAL };
	return { ok: true, value: command.settled ? { settled: true, by } : NOT_SETTLED };
}

/** The state `entry` sets for session `sessionId`, or undefined when it sets none there. */
export function settledStateOf(entry: SessionEntry, sessionId: string): SessionSettled | undefined {
	const data = sessionMarkerData(entry, SESSION_SETTLED_CUSTOM_TYPE, sessionId);
	if (data === undefined) return undefined;
	if (data.settled !== true) return NOT_SETTLED;
	const by = parseThreadSettledBy(data.by);
	return by === undefined ? { settled: true } : { settled: true, by };
}

export function settledFields(state: SessionSettled): SettledFields {
	return state.settled && state.by !== undefined ? { settled: true, settledBy: state.by } : { settled: state.settled };
}

export function readSessionSettled(manager: Pick<SessionManager, "getSettled">): SessionSettled {
	return manager.getSettled();
}

export function setSessionSettled(
	manager: Pick<SessionManager, "appendCustomEntry" | "getSessionId">,
	state: SessionSettled,
): void {
	manager.appendCustomEntry(SESSION_SETTLED_CUSTOM_TYPE, {
		settled: state.settled,
		...(state.settled && state.by !== undefined ? { by: state.by } : {}),
		at: new Date().toISOString(),
		sessionId: manager.getSessionId(),
	});
}
