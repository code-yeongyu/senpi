import chalk from "chalk";
import {
	admitSessionHolders,
	type checkSessionHolders,
	describeSessionHolders,
	type SessionAdmission,
	hostAttachSocket,
	SESSION_HOLDER_LOOKUP_FAILED,
	sessionIdFromFile,
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

/** A live session on this machine's multi-session host that the terminal attaches to instead of opening it. */
export interface HostAttachTarget {
	readonly socket: string;
	readonly sessionId: string;
}

export type StartupAdmission = "open" | "cancelled" | "refused" | { readonly attach: HostAttachTarget };

/**
 * Exit code of a startup refused because another live process holds the session. The schedule runner reads it to
 * leave the occurrence pending instead of failing it (senpi#5756).
 */
export const SESSION_HELD_EXIT_CODE = 76;

export interface StartupAdmissionIo {
	readonly canAsk: boolean;
	readonly confirm: (question: string) => Promise<boolean>;
	readonly err: (line: string) => void;
	readonly lookup?: typeof checkSessionHolders;
	/** The opening can be served by attaching to a host that holds it (not for a rebind, which rewrites the file). */
	readonly canAttach?: boolean;
}

const RETRY = "then open it again";

/**
 * Startup admission for a session another live process holds (senpi#5756, the startup path of #5744): opening it
 * would start a second run of the same session. Without a person to ask it is refused with the holder named; on a
 * terminal the person chooses to cancel or to take over (the holder is asked to exit first, as /resume does).
 * Admission claims the session (senpi#5988): of two simultaneous starts one is admitted and the other finds it as the
 * holder, and the claim stands for this process until its runtime publishes the holder record.
 */
export async function admitStartupSession(
	sessionFile: string | undefined,
	io: StartupAdmissionIo,
): Promise<StartupAdmission> {
	if (sessionFile === undefined) return "open";
	const admission = await admitSessionHolders(sessionFile, io.lookup);
	let decision: StartupAdmission = "refused";
	try {
		decision = await decideAdmission(sessionFile, admission, io);
		return decision;
	} finally {
		if (decision !== "open") await admission.release();
	}
}

function stillHeld(io: StartupAdmissionIo): "refused" {
	io.err(chalk.red(`Not opened: the session is still open in another process; quit it there, ${RETRY}.`));
	return "refused";
}

async function decideAdmission(
	sessionFile: string,
	admission: SessionAdmission,
	io: StartupAdmissionIo,
): Promise<StartupAdmission> {
	const { check } = admission;
	if ("lookupFailed" in check) {
		io.err(chalk.yellow(`Warning: ${SESSION_HOLDER_LOOKUP_FAILED}`));
		return "open";
	}
	const { holders } = check;
	// No holder but no claim either: the start that held the claim ended between the two reads.
	if (holders.length === 0) return admission.claimed || (await admission.retake()) ? "open" : stillHeld(io);
	// #6059: held by this machine's multi-session host (the OmO desktop's engine): a terminal follows that live session
	// over the host, so what either side does shows on the other, instead of being refused or a second writer.
	const socket = io.canAsk && io.canAttach === true ? hostAttachSocket(holders) : undefined;
	const sessionId = socket === undefined ? undefined : await sessionIdFromFile(sessionFile);
	if (socket !== undefined && sessionId !== undefined) return { attach: { socket, sessionId } };
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
	// A holder that was still only starting held the claim; it is this process's to take now.
	return stopped && (await admission.retake()) ? "open" : stillHeld(io);
}
