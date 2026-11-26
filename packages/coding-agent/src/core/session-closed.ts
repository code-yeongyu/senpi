/**
 * The clean-stop record of a graceful close (oh-my-openagent#14313). A session closed on request ends with one
 * `session-closed` custom entry: the turn it waited for, what it handed back unread and which work sources it stopped.
 * The model never sees it; a reopen reads it as "this session ended on purpose", never as an interrupted run.
 */

/** The `session-closed` custom entry type. */
export const SESSION_CLOSED_ENTRY = "session-closed";

/** The engine-turn hold a draining graceful close keeps while the running turn ends. */
export const CLOSING_HOLD_KEY = "closing";

export interface SessionClosedRecord {
	readonly graceful: true;
	/** The session's turn epoch when it closed: the last turn it ran. */
	readonly turn: number;
	readonly waited_ms: number;
	/** Delivery ids handed back unwritten, and the user's queued text, in enqueue order. */
	readonly returned: { readonly deliveries: readonly string[]; readonly user_messages: readonly string[] };
	/** Wake sources (monitors, background jobs, loops) live at the close: stopped, not restored on a reopen. */
	readonly stopped: { readonly wake_sources: readonly string[] };
	readonly at: string;
}
