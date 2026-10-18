import { isHandoffBusy } from "./handoff-activity.ts";
import { sessionDirectoryRemoved } from "./session-path-key.ts";
import type { RpcSessionEntry, RpcSessionRegistry } from "./session-registry.ts";

export interface DrainVerdicts {
	/** Settled sessions a handoff parks: the successor reopens each by its `sessionPath`. */
	readonly park: readonly string[];
	/**
	 * Settled sessions whose transcript directory is gone. Nothing can reopen them by path, so the
	 * drain ends them as `session_dir_removed` instead of handing out a dead path (senpi#2285).
	 */
	readonly gone: readonly string[];
}

/**
 * One handoff-drain pass's decisions. Every session is judged on its own: a session whose activity
 * cannot be read cannot be proven busy, so it parks like any other (reported through `unreadable`)
 * and never strands the rest on a superseded generation. The pass adds no path resolution of its
 * own: the gone check only stats the directory of the path the registry already holds.
 */
export function selectDrainVerdicts(
	registry: Pick<RpcSessionRegistry, "list" | "peek">,
	inFlight: (sessionId: string) => boolean,
	unreadable: (sessionId: string, cause: unknown) => void,
): DrainVerdicts {
	const park: string[] = [];
	const gone: string[] = [];
	for (const { sessionId, status, sessionPath } of registry.list()) {
		if (status !== "open" || inFlight(sessionId)) continue;
		const entry = registry.peek(sessionId);
		if (!entry || handoffBusy(entry, sessionId, unreadable)) continue;
		if (sessionPath !== undefined && sessionDirectoryRemoved(sessionPath)) gone.push(sessionId);
		else park.push(sessionId);
	}
	return { park, gone };
}

function handoffBusy(
	entry: RpcSessionEntry,
	sessionId: string,
	unreadable: (sessionId: string, cause: unknown) => void,
): boolean {
	try {
		// Both signals are optional: a runtime that does not publish an activity snapshot cannot be
		// proven busy, and a park that waits for a signal the runtime never emits would strand the
		// session on the old generation.
		const snapshot = entry.runtime?.session.activitySnapshot;
		return entry.worker?.handoffBusy === true || (snapshot !== undefined && isHandoffBusy(snapshot));
	} catch (cause) {
		unreadable(sessionId, cause);
		return false;
	}
}

/** One drain pass for the host: logs what it skips, and `undefined` when the pass failed as a whole. */
export function readDrainVerdicts(
	registry: Pick<RpcSessionRegistry, "list" | "peek">,
	inFlight: (sessionId: string) => boolean,
): DrainVerdicts | undefined {
	try {
		return selectDrainVerdicts(registry, inFlight, (sessionId, cause) => {
			process.stderr.write(`senpi rpc handoff activity of ${sessionId} unreadable, parking: ${String(cause)}\n`);
		});
	} catch (cause) {
		process.stderr.write(`senpi rpc handoff drain pass failed, retrying: ${String(cause)}\n`);
		return undefined;
	}
}
