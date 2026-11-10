import type { SessionManager } from "./session-manager.ts";

/**
 * Who started a turn, for the delegated-default permission rule (remote approval-mode work):
 * - `local`: a local connection's or the TUI's own input;
 * - `delegated`: input that arrived on a delegated (remote device) connection;
 * - `peer`: a relayed delivery from an agent on a remote device of the same account, whose device is the delegation's
 *   principal (senpi#6305): it runs under the receiving session's own preset, as the session's own work does;
 * - `engine`: a turn no client record started (an extension's message, a goal or loop turn, restored input).
 * A steer joins the running turn (`join`) and never changes its origin.
 */
export type TurnOrigin = "local" | "delegated" | "peer" | "engine";
export type InputTurnMark = TurnOrigin | "join";
export type ConnectionOrigin = "local" | "delegated";

const DELEGATED_ORIGIN_ENTRY = "delegated_origin";

type OriginSessionManager = Pick<SessionManager, "getEntries" | "appendCustomEntry">;

const inputMarks = new WeakMap<object, InputTurnMark>();
const currentOrigins = new WeakMap<object, TurnOrigin>();
const delegatedSessions = new WeakSet<object>();

/** The mark an input gets where it is created: explicit for client records, `local` for the TUI, else `engine`. */
export function inputTurnMark(input: {
	readonly mode?: "steer" | "followUp";
	readonly connectionOrigin?: ConnectionOrigin;
	readonly source?: string;
}): InputTurnMark {
	if (input.mode === "steer") return "join";
	if (input.connectionOrigin !== undefined) return input.connectionOrigin;
	return input.source === undefined || input.source === "interactive" ? "local" : "engine";
}

export function markInputTurnOrigin(message: object, mark: InputTurnMark): void {
	inputMarks.set(message, mark);
}

/** Carries `from`'s origin mark onto `to`, a copy of the same input: a copy without it would open or join a turn unmarked. */
export function copyInputTurnMark(from: object, to: object): void {
	const mark = inputMarks.get(from);
	if (mark !== undefined) inputMarks.set(to, mark);
}

/** Whether a message carries an origin mark: a user message always opens a turn's origin, any other only when marked. */
export function hasInputTurnMark(message: object): boolean {
	return inputMarks.has(message);
}

/** A run starts as engine work; the user message that opens a turn sets its origin, a steer keeps it. */
export function noteRunStart(sessionManager: object): void {
	currentOrigins.set(sessionManager, "engine");
}

export function noteUserMessageStart(sessionManager: object, message: object): void {
	const mark = inputMarks.get(message);
	if (mark === "join") return;
	currentOrigins.set(sessionManager, mark ?? "engine");
}

export function recordDelegatedOrigin(sessionManager: OriginSessionManager): void {
	if (delegatedOriginOf(sessionManager)) return;
	delegatedSessions.add(sessionManager);
	sessionManager.appendCustomEntry(DELEGATED_ORIGIN_ENTRY, { delegatedOrigin: true }, { startupBookkeeping: true });
}

// How many entries a session's scan has already found free of the marker: each gated decision reads only new entries.
const scannedEntries = new WeakMap<object, number>();

function delegatedOriginOf(sessionManager: Pick<SessionManager, "getEntries">): boolean {
	if (delegatedSessions.has(sessionManager)) return true;
	const entries = sessionManager.getEntries();
	const persisted = entries
		.slice(scannedEntries.get(sessionManager) ?? 0)
		.some((entry) => entry.type === "custom" && entry.customType === DELEGATED_ORIGIN_ENTRY);
	if (persisted) delegatedSessions.add(sessionManager);
	else scannedEntries.set(sessionManager, entries.length);
	return persisted;
}

/** Whether the deciding turn counts as delegated-origin: a remote device started it, or nobody did on a remote-driven session. */
export function decidingTurnIsDelegated(sessionManager: Pick<SessionManager, "getEntries">): boolean {
	const origin = currentOrigins.get(sessionManager) ?? "engine";
	if (origin === "delegated") return true;
	return origin === "engine" && delegatedOriginOf(sessionManager);
}
