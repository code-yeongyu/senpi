import chalk from "chalk";
import { sessionHolderWarning } from "../core/foreign-session-holders.ts";
import type { AppMode } from "../core/project-trust.ts";
import type { SessionManager } from "../core/session-manager.ts";

/** Warn after the runtime publishes its holder; an advisory lookup must not abort startup. */
export async function prepareSessionOpening(manager: SessionManager, mode: AppMode): Promise<void> {
	if (mode === "interactive") {
		const warning = await sessionHolderWarning(manager.getSessionFile(), manager.getSessionId());
		if (warning !== undefined) console.error(chalk.yellow(`Warning: ${warning}`));
	}
}
