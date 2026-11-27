import type { ExtensionAPI } from "../../types.ts";
import type { HerdrState } from "./state.ts";

/** Bus channel on which a consumer asks the session's liveness watcher for its handle. */
export const SESSION_LIVENESS_CONNECT_EVENT = "session_liveness_connect";

/** The session's one liveness fold, shared by every consumer (the herdr pane report, the todo widget). */
export interface SessionLiveness {
	readonly state: () => HerdrState;
	readonly working: () => boolean;
	/** Runs after every fold; the event that caused the fold awaits what the listener returns. */
	readonly subscribe: (listener: (state: HerdrState) => unknown) => () => void;
}

export type SessionLivenessReply = (liveness: SessionLiveness) => void;

/**
 * The bound session's watcher, or undefined when no session-liveness watcher is bound on this bus. Ask from a
 * `session_start` handler: the watcher registers first among the builtins and binds in its own `session_start`.
 */
export function connectSessionLiveness(events: Pick<ExtensionAPI["events"], "emit">): SessionLiveness | undefined {
	let liveness: SessionLiveness | undefined;
	const reply: SessionLivenessReply = (handle) => {
		liveness = handle;
	};
	events.emit(SESSION_LIVENESS_CONNECT_EVENT, reply);
	return liveness;
}
