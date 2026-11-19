/**
 * What a host restart released on a session that was live when the previous host ended (senpi#7020). The restart
 * owns two holds and nothing else: the superseded host's drain hold (`HOST_DRAIN_HOLD_KEY`), and the interrupted-run
 * hold over a run the restart cut short, when the engine started that run. A run a person started waits for that
 * person; a run that was itself the continuation of a cut run is not continued again, so a crash loop stops at one.
 */
import { ENGINE_TURN_START_ENTRY_TYPE, isUserDirectedTurn } from "./engine-turn-limit.ts";
import type { SessionHold } from "./engine-turn-hold.ts";
import type { SessionEntry } from "./session-manager.ts";

/** The hold a superseded host's drain puts on a session nobody is attached to (senpi#3114). */
export const HOST_DRAIN_HOLD_KEY = "host-drain";
export const INTERRUPTED_RUN_HOLD_KEY = "interrupted-run";

/** Whether the newest run on the branch was started by the engine, not by a person or a resume of a cut run. */
export function engineStartedLastRun(branch: readonly SessionEntry[]): boolean {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry === undefined) continue;
		if (entry.type === "message" && entry.message.role === "user") return false;
		if (entry.type === "custom_message" && isUserDirectedTurn(entry.customType)) return false;
		if (entry.type === "custom" && entry.customType === ENGINE_TURN_START_ENTRY_TYPE) return true;
	}
	return false;
}

/**
 * `resume`: the restart's holds are the only ones, so the session resumes through the ordinary Resume path. `release`:
 * another hold stays (a person's Stop, an unattended hold the session already had), so only the drain hold is dropped.
 */
export function restartRelease(
	holds: readonly SessionHold[],
	branch: () => readonly SessionEntry[],
): { readonly resume: true; readonly interruptedRun: boolean } | { readonly release: readonly string[] } | undefined {
	const restartKeys = new Set([HOST_DRAIN_HOLD_KEY]);
	if (holds.some((hold) => hold.key === INTERRUPTED_RUN_HOLD_KEY) && engineStartedLastRun(branch()))
		restartKeys.add(INTERRUPTED_RUN_HOLD_KEY);
	const restartHolds = holds.filter((hold) => restartKeys.has(hold.key));
	if (restartHolds.length === 0) return undefined;
	if (restartHolds.length === holds.length)
		return { resume: true, interruptedRun: restartKeys.has(INTERRUPTED_RUN_HOLD_KEY) };
	return holds.some((hold) => hold.key === HOST_DRAIN_HOLD_KEY) ? { release: [HOST_DRAIN_HOLD_KEY] } : undefined;
}
