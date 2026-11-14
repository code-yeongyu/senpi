/**
 * Whether a move's landing file is taken (senpi#6471). A file there that holds another session, or a copy of the moved
 * session that can still be written, occupies it; so does anything else by that name that is not this session's file. A sealed predecessor of the moved session does not: the import
 * replaces that one. Both steps ask this one question, so they cannot come to disagree: `prepare` asks before the
 * source releases and only reads, and the import asks again inside its commit, because the folder can change between.
 */
import { lstat } from "node:fs/promises";
import { loadEntriesFromFileAsync } from "../session-manager.ts";
import { headerSessionId, sessionOwnership } from "./ownership.ts";

export class MoveTargetOccupiedError extends Error {
	readonly code = "move_target_occupied";

	constructor(target: string) {
		super(
			`A session that can still be written already sits at ${target}; the moved session was not imported over it. Close or move that session first, then send it again.`,
		);
		this.name = "MoveTargetOccupiedError";
	}
}

/** What stands where a moved session would land: nothing, its own sealed predecessor, or something that keeps the place. */
export type LandingFile = "free" | "predecessor" | "occupied";

/**
 * Whether a name stands at `target`. Only "nothing by that name" is absence. A link counts as a name even when it leads
 * nowhere, and any other failure to look is thrown: a place that cannot be looked at is never free.
 */
async function nameStands(target: string): Promise<boolean> {
	try {
		await lstat(target);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export async function landingFile(target: string, sessionId: string): Promise<LandingFile> {
	if (!(await nameStands(target))) return "free";
	const entries = await loadEntriesFromFileAsync(target);
	return headerSessionId(entries) !== sessionId || sessionOwnership(entries).writable ? "occupied" : "predecessor";
}
