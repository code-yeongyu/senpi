/**
 * What a host restart released on a session that was live when the previous host ended (senpi#7020). The restart
 * owns two holds and nothing else: the superseded host's drain hold (`HOST_DRAIN_HOLD_KEY`), and the interrupted-run
 * hold over a run the restart cut short, when the engine started that run. A run a person started waits for that
 * person. A continuation of a cut run is continued again when it made progress before the next cut, up to
 * `RESTART_CONTINUATION_LIMIT` continuations without new input, so a crash loop stops (senpi#7079).
 */
import { ENGINE_TURN_START_ENTRY_TYPE, isUserDirectedTurn, resetsEngineTurnHistory } from "./engine-turn-limit.ts";
import type { SessionHold } from "./engine-turn-hold.ts";
import { SESSION_CONTROL_DELIVERY_TYPE } from "./extensions/session-control-types.ts";
import type { SessionEntry } from "./session-manager.ts";
import { STOP_RESUME_CUSTOM_TYPE } from "./stop-resume-directive.ts";

/** The hold a superseded host's drain puts on a session nobody is attached to (senpi#3114). */
export const HOST_DRAIN_HOLD_KEY = "host-drain";
const INTERRUPTED_RUN_HOLD_KEY = "interrupted-run";

/** Consecutive continuations of a cut run without a person's input or a peer delivery in between (senpi#7079). */
const RESTART_CONTINUATION_LIMIT = 3;

/** Why a restart left an engine-started run held: it keeps being cut with no progress, or it reached the limit. */
export type RestartHoldReason = "repeated_restart_no_progress" | "repeated_restart_limit";

type RestartVerdict = { readonly continue: true } | { readonly continue: false; readonly reason?: RestartHoldReason };

function isRestartContinuation(entry: SessionEntry): boolean {
	return (
		entry.type === "custom_message" &&
		entry.customType === STOP_RESUME_CUSTOM_TYPE &&
		(entry.details as { resumeCause?: unknown } | undefined)?.resumeCause === "interrupted"
	);
}

/** A completed model response or a recorded tool result; a result the restore wrote for a cut tool is not progress. */
function isProgress(entry: SessionEntry): boolean {
	if (entry.type !== "message") return false;
	const message = entry.message;
	if (message.role === "assistant")
		return message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse";
	if (message.role !== "toolResult") return false;
	return (message.details as { interrupted?: unknown } | undefined)?.interrupted === undefined;
}

/** A person's input or a peer delivery: what a session that keeps continuing after restarts never sends itself. */
function isNewInput(entry: SessionEntry): boolean {
	if (entry.type === "message") return entry.message.role === "user";
	if (entry.type !== "custom_message") return false;
	return (
		entry.customType === SESSION_CONTROL_DELIVERY_TYPE || resetsEngineTurnHistory(entry.customType, entry.details)
	);
}

/**
 * Whether the run the restart cut continues. Continuations of a cut run are walked past to the run's own start: a run
 * the engine started continues, a run a person started does not. Continuations since the newest input are counted.
 */
function restartVerdict(branch: readonly SessionEntry[]): RestartVerdict {
	let continuations = 0;
	let progressed = false;
	let engineStarted: boolean | undefined;
	for (let index = branch.length - 1; index >= 0 && engineStarted === undefined; index--) {
		const entry = branch[index];
		if (entry === undefined) continue;
		if (continuations === 0 && isProgress(entry)) progressed = true;
		if (isRestartContinuation(entry)) continuations++;
		else if (entry.type === "message" && entry.message.role === "user") engineStarted = false;
		else if (entry.type === "custom_message" && isUserDirectedTurn(entry.customType)) engineStarted = false;
		else if (entry.type === "custom" && entry.customType === ENGINE_TURN_START_ENTRY_TYPE) engineStarted = true;
	}
	if (engineStarted !== true) return { continue: false };
	if (continuations === 0) return { continue: true };
	if (!progressed) return { continue: false, reason: "repeated_restart_no_progress" };
	let sinceInput = 0;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry === undefined) continue;
		if (isNewInput(entry)) break;
		if (isRestartContinuation(entry)) sinceInput++;
	}
	return sinceInput >= RESTART_CONTINUATION_LIMIT
		? { continue: false, reason: "repeated_restart_limit" }
		: { continue: true };
}

/** The data the interrupted-run hold carries on a session the restart left held for a repeated restart. */
export function restartHoldData(
	continued: boolean,
	branch: () => readonly SessionEntry[],
): { readonly reason: RestartHoldReason } | undefined {
	if (!continued) return undefined;
	const verdict = restartVerdict(branch());
	return verdict.continue || verdict.reason === undefined ? undefined : { reason: verdict.reason };
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
	if (holds.some((hold) => hold.key === INTERRUPTED_RUN_HOLD_KEY) && restartVerdict(branch()).continue)
		restartKeys.add(INTERRUPTED_RUN_HOLD_KEY);
	const restartHolds = holds.filter((hold) => restartKeys.has(hold.key));
	if (restartHolds.length === 0) return undefined;
	if (restartHolds.length === holds.length)
		return { resume: true, interruptedRun: restartKeys.has(INTERRUPTED_RUN_HOLD_KEY) };
	return holds.some((hold) => hold.key === HOST_DRAIN_HOLD_KEY) ? { release: [HOST_DRAIN_HOLD_KEY] } : undefined;
}
