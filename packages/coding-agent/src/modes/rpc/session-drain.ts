import { sessionDirectoryRemoved } from "./session-path-key.ts";
import type { RpcSessionRegistry } from "./session-registry.ts";
import { entryTransferBlockers, type TransferBlocker } from "./session-transfer-quiescence.ts";

export interface DrainVerdicts {
	/** Settled sessions a handoff parks: the successor reopens each by its `sessionPath`. */
	readonly park: readonly string[];
	/**
	 * Settled sessions whose transcript directory is gone. Nothing can reopen them by path, so the
	 * drain ends them as `session_dir_removed` instead of handing out a dead path (senpi#2285).
	 */
	readonly gone: readonly string[];
	/**
	 * Open sessions this generation keeps for now, with what holds each one: work in progress, a request
	 * in flight, or activity that could not be read (`unknown`). A held session keeps its owner and its
	 * work; the next pass judges it again (code-yeongyu/oh-my-openagent#10091).
	 */
	readonly held: ReadonlyMap<string, readonly TransferBlocker[]>;
}

/**
 * One handoff-drain pass's decisions. Every session is judged on its own, by the strict transfer check
 * `release_session` uses: a session is parked only when it is proven quiet, and one whose activity
 * cannot be read is held rather than handed to a successor that would become its second writer. One
 * held session never strands the rest (senpi#2285). The gone check only stats the directory of the
 * path the registry already holds.
 */
export function selectDrainVerdicts(
	registry: Pick<RpcSessionRegistry, "list" | "peek">,
	inFlight: (sessionId: string) => boolean,
	pendingPrompts: (sessionId: string) => number,
): DrainVerdicts {
	const park: string[] = [];
	const gone: string[] = [];
	const held = new Map<string, readonly TransferBlocker[]>();
	for (const { sessionId, status, sessionPath } of registry.list()) {
		if (status !== "open") continue;
		if (inFlight(sessionId)) {
			held.set(sessionId, ["request"]);
			continue;
		}
		const entry = registry.peek(sessionId);
		if (!entry) continue;
		const blockers = entryTransferBlockers(entry, () => pendingPrompts(sessionId), 0);
		if (blockers.length > 0) held.set(sessionId, blockers);
		else if (sessionPath !== undefined && sessionDirectoryRemoved(sessionPath)) gone.push(sessionId);
		else park.push(sessionId);
	}
	return { park, gone, held };
}

/** One drain pass for the host: `undefined` when the pass failed as a whole. */
export function readDrainVerdicts(
	registry: Pick<RpcSessionRegistry, "list" | "peek">,
	inFlight: (sessionId: string) => boolean,
	pendingPrompts: (sessionId: string) => number,
): DrainVerdicts | undefined {
	try {
		return selectDrainVerdicts(registry, inFlight, pendingPrompts);
	} catch (cause) {
		process.stderr.write(`senpi rpc handoff drain pass failed, retrying: ${String(cause)}\n`);
		return undefined;
	}
}
