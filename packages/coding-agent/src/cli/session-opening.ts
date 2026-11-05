import chalk from "chalk";
import {
	checkSessionHolders,
	describeSessionHolders,
	SESSION_HOLDER_LOOKUP_FAILED,
	sessionHolderWarning,
	stopSessionHolders,
	takeOverRefusal,
} from "../core/foreign-session-holders.ts";
import type { AppMode } from "../core/project-trust.ts";
import type { SessionManager } from "../core/session-manager.ts";

/** Warn after the runtime publishes its holder; an advisory lookup must not abort startup. */
export async function prepareSessionOpening(manager: SessionManager, mode: AppMode): Promise<void> {
	if (mode === "interactive") {
		const warning = await sessionHolderWarning(manager.getSessionFile(), manager.getSessionId());
		if (warning !== undefined) console.error(chalk.yellow(`Warning: ${warning}`));
	}
}

export type StartupAdmission = "open" | "cancelled" | "refused";

export interface StartupAdmissionIo {
	readonly canAsk: boolean;
	readonly confirm: (question: string) => Promise<boolean>;
	readonly err: (line: string) => void;
	readonly lookup?: typeof checkSessionHolders;
}

const RETRY = "then open it again";

/**
 * Startup admission for a session another live process holds (senpi#5756, the startup path of #5744): opening it
 * would start a second run of the same session. Without a person to ask it is refused with the holder named; on a
 * terminal the person chooses to cancel or to take over (the holder is asked to exit first, as /resume does).
 */
export async function admitStartupSession(
	sessionFile: string | undefined,
	io: StartupAdmissionIo,
): Promise<StartupAdmission> {
	if (sessionFile === undefined) return "open";
	const check = await (io.lookup ?? checkSessionHolders)(sessionFile);
	if ("lookupFailed" in check) {
		io.err(chalk.yellow(`Warning: ${SESSION_HOLDER_LOOKUP_FAILED}`));
		return "open";
	}
	const { holders } = check;
	if (holders.length === 0) return "open";
	const held = `This session is open in another process (${describeSessionHolders(holders)}); opening it here would start a second run of the same session.`;
	const refusal = takeOverRefusal(holders, RETRY);
	if (!io.canAsk || refusal !== undefined) {
		io.err(chalk.red(`Not opened: ${held} ${refusal ?? `Quit it there, ${RETRY}.`}`));
		return "refused";
	}
	if (!(await io.confirm(`${held}\nTake over (stop it there)?`))) {
		io.err(`Not opened: the session is open in another process (${describeSessionHolders(holders)}).`);
		return "cancelled";
	}
	let stopped: boolean;
	try {
		stopped = await stopSessionHolders(sessionFile, holders);
	} catch (error: unknown) {
		io.err(
			chalk.red(
				`Not opened: could not stop the other process (${error instanceof Error ? error.message : String(error)}).`,
			),
		);
		return "refused";
	}
	if (!stopped) {
		io.err(chalk.red(`Not opened: the session is still open in another process; quit it there, ${RETRY}.`));
		return "refused";
	}
	return "open";
}
