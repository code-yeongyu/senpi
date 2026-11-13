import { AsyncLocalStorage } from "node:async_hooks";
import { hasFunctions, realmRegistry } from "@earendil-works/pi-realm-registry";

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

const inputMarks = new WeakMap<object, InputTurnMark>();
const currentOrigins = new WeakMap<object, TurnOrigin>();
const continuingTurns = new WeakSet<object>();

/**
 * The record being handled, for the work its own handling creates (senpi#6342). It lives in that record's async
 * context, so no other record can change or clear it. The first run that record starts takes the origin and closes it,
 * so later engine work that merely descends from that run (an extension's follow-up) does not inherit it.
 *
 * It is a realm registry (omo#12965): the RPC handler of one engine copy enters it, and the session that takes the
 * input or starts the run may belong to another copy. The store and its mutable record never leave the closure.
 */
interface RecordScopes {
	run<T>(origin: ConnectionOrigin, handle: () => Promise<T>): Promise<T>;
	delegated(): boolean;
	/** Reads whether an open delegated record starts this run, and closes the record. */
	closeAtRunStart(): boolean;
}

const recordScope = realmRegistry(
	"@code-yeongyu/senpi/turn-origin/v1",
	(): RecordScopes => {
		const scopes = new AsyncLocalStorage<{ readonly origin: ConnectionOrigin; open: boolean }>();
		const delegated = () => {
			const scope = scopes.getStore();
			return scope?.open === true && scope.origin === "delegated";
		};
		return {
			// Any origin other than "local" (one a newer copy defines) is treated as delegated: it fails closed.
			run: (origin, handle) =>
				scopes.run({ origin: origin === "local" ? "local" : "delegated", open: true }, handle),
			delegated,
			closeAtRunStart: () => {
				const opened = delegated();
				const scope = scopes.getStore();
				if (scope !== undefined) scope.open = false;
				return opened;
			},
		};
	},
	(value): value is RecordScopes => hasFunctions(value, ["run", "delegated", "closeAtRunStart"]),
);

/** The mark an input gets where it is created: explicit for client records, `local` for the TUI, else `engine`. */
export function inputTurnMark(input: {
	readonly mode?: "steer" | "followUp";
	readonly connectionOrigin?: ConnectionOrigin;
	readonly source?: string;
}): InputTurnMark {
	if (input.mode === "steer") return "join";
	if (input.connectionOrigin !== undefined) return input.connectionOrigin;
	if (recordIsDelegated()) return "delegated";
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

/** Runs `handle`, and every async task it starts, as the record `origin` describes. */
export function runInRecordScope<T>(origin: ConnectionOrigin, handle: () => Promise<T>): Promise<T> {
	return recordScope.run(origin, handle);
}

/** Whether the work being created belongs to an open cross-account record's own handling. */
export function recordIsDelegated(): boolean {
	return recordScope.delegated() === true;
}

/**
 * A run starts as engine work, or as delegated work when a cross-account record's own handling starts it; a retry keeps
 * the turn it continues. The user message that opens a turn sets its origin, a steer keeps it.
 */
export function noteRunStart(sessionManager: object): void {
	if (continuingTurns.has(sessionManager)) return;
	currentOrigins.set(sessionManager, recordScope.closeAtRunStart() === true ? "delegated" : "engine");
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

/** Whether the deciding turn counts as delegated-origin: a cross-account device started this turn or this run. */
export function decidingTurnIsDelegated(sessionManager: object): boolean {
	return currentOrigins.get(sessionManager) === "delegated";
}
