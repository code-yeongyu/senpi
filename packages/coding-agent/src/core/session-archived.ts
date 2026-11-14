/**
 * A thread's archived flag, durable in its own session file (fork-owned).
 *
 * The flag is a `custom` entry of type `session_archived` with `data: { archived }`, appended like any extension
 * entry, so the desktop app, the CLI, the TUI and a relay listing on another device all read the same file. The
 * newest such entry wins; a session that never wrote one is not archived. Custom entries never reach the model.
 */
import type { SessionManager } from "./session-manager.ts";

export const SESSION_ARCHIVED_CUSTOM_TYPE = "session_archived";

type ArchivedManager = Pick<SessionManager, "getEntries" | "appendCustomEntry">;

export function isSessionArchived(manager: ArchivedManager): boolean {
	const entries = manager.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== SESSION_ARCHIVED_CUSTOM_TYPE) continue;
		return (entry.data as { archived?: unknown } | undefined)?.archived === true;
	}
	return false;
}

export function setSessionArchived(manager: ArchivedManager, archived: boolean): void {
	manager.appendCustomEntry(SESSION_ARCHIVED_CUSTOM_TYPE, { archived });
}
