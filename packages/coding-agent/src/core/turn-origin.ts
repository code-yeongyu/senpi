/**
 * Who started a turn, for the remote approval-mode rule (senpi#6342: a turn follows the permission setting of the machine
 * it runs on, and no origin outlives the turn it started):
 * - `local`: this machine's own input, or input from a device the forwarder stated is the same account;
 * - `delegated`: input from a device the forwarder did not state is the same account, or the one run such a device's
 *   record started;
 * - `engine`: a turn no client record started (an extension's message, a goal or loop turn, restored input).
 * A steer joins the running turn (`join`) and never changes its origin.
 */
export type TurnOrigin = "local" | "delegated" | "engine";
export type InputTurnMark = TurnOrigin | "join";
export type ConnectionOrigin = "local" | "delegated";
/** One record's claim on the next run it starts; only that record can withdraw it. */
export type DelegatedRunMark = { readonly record: object };

const inputMarks = new WeakMap<object, InputTurnMark>();
const currentOrigins = new WeakMap<object, TurnOrigin>();
const delegatedRuns = new WeakMap<object, DelegatedRunMark>();
const continuingTurns = new WeakSet<object>();

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

/**
 * A run starts as engine work, or as delegated work when a cross-account device's record asked for it; the user message
 * that opens a turn sets its origin, a steer keeps it.
 */
export function noteRunStart(sessionManager: object): void {
	if (delegatedRuns.delete(sessionManager)) currentOrigins.set(sessionManager, "delegated");
	else if (!continuingTurns.has(sessionManager)) currentOrigins.set(sessionManager, "engine");
}

/** A retry or recovery run repeats the turn it continues, so it keeps that turn's origin until the continuation ends. */
export function noteTurnContinuation(sessionManager: object): void {
	continuingTurns.add(sessionManager);
}

export function endTurnContinuation(sessionManager: object): void {
	continuingTurns.delete(sessionManager);
}

export function noteUserMessageStart(sessionManager: object, message: object): void {
	const mark = inputMarks.get(message);
	if (mark === "join") return;
	currentOrigins.set(sessionManager, mark ?? "engine");
}

/** A cross-account device's record that can act on the session's work: the next run it starts counts as delegated, once. */
export function noteDelegatedRun(sessionManager: object, record: object): DelegatedRunMark {
	const mark = { record };
	delegatedRuns.set(sessionManager, mark);
	return mark;
}

/** A local record that can act on the session's work owns the next run, so no cross-account mark outlives it. */
export function clearDelegatedRun(sessionManager: object): void {
	delegatedRuns.delete(sessionManager);
}

/** Withdraws `mark` if no run used it: a record that started no run leaves no origin behind. A later record's mark stays. */
export function dropDelegatedRun(sessionManager: object, mark: DelegatedRunMark): void {
	if (delegatedRuns.get(sessionManager) === mark) delegatedRuns.delete(sessionManager);
}

/** Whether the deciding turn counts as delegated-origin: a cross-account device started this turn or this run. */
export function decidingTurnIsDelegated(sessionManager: object): boolean {
	return currentOrigins.get(sessionManager) === "delegated";
}
