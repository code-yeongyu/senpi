import type { LifecycleWaits } from "./session-lifecycle-types.ts";
import type { WorkCustodyRecord } from "./work-custody-record.ts";

/** Named background sources one lifecycle snapshot carries; the rest are only counted (senpi#5612). */
export const MAX_BACKGROUND_WAIT_SOURCES = 32;

/**
 * The custody a session still waits on. A consumed delivery's message is already in the conversation: its record
 * stays open until its run settles, for crash recovery (senpi#4848), but nothing waits on it (senpi#5612).
 */
export function waitingCustody(active: readonly WorkCustodyRecord[]): readonly WorkCustodyRecord[] {
	return active.filter((record) => record.state !== "consumed");
}

/**
 * Every snapshot, and so every `session-lifecycle` record, names at most the first 32 background sources and counts
 * the rest, so a record's size does not grow with the number of open sources (senpi#5612).
 */
export function boundBackground(
	background: LifecycleWaits["background"],
	alreadyOmitted = 0,
): Pick<LifecycleWaits, "background" | "backgroundOmitted"> {
	const omitted = Math.max(0, background.length - MAX_BACKGROUND_WAIT_SOURCES) + alreadyOmitted;
	return {
		background: background.slice(0, MAX_BACKGROUND_WAIT_SOURCES),
		...(omitted > 0 ? { backgroundOmitted: omitted } : {}),
	};
}
