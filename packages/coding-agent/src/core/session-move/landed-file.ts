import { loadEntriesFromFileAsync } from "../session-manager.ts";
import { pathExists } from "../tools/path-utils.ts";
import type { LandingOutcome } from "./move-landing.ts";
import { type MoveId, SESSION_MOVED, SESSION_MOVED_IN } from "./ownership.ts";
import { REVOKED } from "./revoke.ts";

/**
 * Where an accepted move landed, as `status` answers it (senpi#6436): the session file the move's record names, with
 * the id and the folder that file's header names. `gone` when no file is there, or the file there no longer records
 * the move: a move lands once, so nothing else stands in for it.
 */
export type LandedFile = { readonly sessionPath: string; readonly sessionId: string; readonly cwd: string } | "gone";

type Entries = Awaited<ReturnType<typeof loadEntriesFromFileAsync>>;

/** What a session file's entries record for the move: nothing, its import, or its import and then a revoke. */
export function outcomeIn(entries: Entries, moveId: MoveId): LandingOutcome {
	let outcome: LandingOutcome = "absent";
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		const data = entry.data as { move_id?: unknown; reason?: unknown } | undefined;
		if (data?.move_id !== moveId) continue;
		if (entry.customType === SESSION_MOVED_IN) outcome = "moved_in";
		else if (outcome === "moved_in" && entry.customType === SESSION_MOVED && data.reason === REVOKED)
			outcome = "revoked";
	}
	return outcome;
}

/** One read of the file at a move's landing target: what it records for the move, and where that puts the session. */
export async function readLanding(
	target: string,
	moveId: MoveId,
): Promise<{ readonly outcome: LandingOutcome; readonly file: LandedFile }> {
	if (!(await pathExists(target))) return { outcome: "absent", file: "gone" };
	const entries = await loadEntriesFromFileAsync(target);
	const outcome = outcomeIn(entries, moveId);
	const header = entries.find((entry) => entry.type === "session");
	if (outcome === "absent" || header === undefined || !header.id || !header.cwd) return { outcome, file: "gone" };
	return { outcome, file: { sessionPath: target, sessionId: header.id, cwd: header.cwd } };
}
