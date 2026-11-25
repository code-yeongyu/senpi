/**
 * A thread's archived flag, durable in its own session file (fork-owned).
 *
 * The flag is a `custom` entry of type `session_archived` with `data: { archived, sessionId }`, appended like any
 * extension entry, so the desktop app, the CLI, the TUI and a relay listing on another device all read the same file.
 * The newest such entry wins; a session that never wrote one is not archived. Custom entries never reach the model.
 *
 * An entry counts only for the session it names, like an ownership entry (`session-move/ownership.ts`): a fork or a
 * clone is a new thread under a new id, so the markers it copied from its source name the source and leave it
 * unarchived. The session manager keeps the flag current on every append and index rebuild (`isArchived()`), so a
 * read never materializes the history (senpi#3519).
 */
import type { SessionEntry, SessionManager } from "./session-manager.ts";

const SESSION_ARCHIVED_CUSTOM_TYPE = "session_archived";

/**
 * The data of `entry` when it is a `customType` marker written for session `sessionId`, else undefined. Every
 * per-thread flag kept in the session file (archived, settled) counts only for the session it names this way.
 */
export function sessionMarkerData(
	entry: SessionEntry,
	customType: string,
	sessionId: string,
): Readonly<Record<string, unknown>> | undefined {
	if (entry.type !== "custom" || entry.customType !== customType) return undefined;
	const data = entry.data as Readonly<Record<string, unknown>> | undefined;
	return data?.sessionId === sessionId ? data : undefined;
}

/** The flag `entry` sets for session `sessionId`, or undefined when it sets none there. */
export function archivedFlagOf(entry: SessionEntry, sessionId: string): boolean | undefined {
	const data = sessionMarkerData(entry, SESSION_ARCHIVED_CUSTOM_TYPE, sessionId);
	return data === undefined ? undefined : data.archived === true;
}

export function isSessionArchived(manager: Pick<SessionManager, "isArchived">): boolean {
	return manager.isArchived();
}

export function setSessionArchived(
	manager: Pick<SessionManager, "appendCustomEntry" | "getSessionId">,
	archived: boolean,
): void {
	manager.appendCustomEntry(SESSION_ARCHIVED_CUSTOM_TYPE, { archived, sessionId: manager.getSessionId() });
}
