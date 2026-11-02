import { sessionDirectoryRemoved } from "./session-path-key.ts";
import type { RpcSessionRegistry } from "./session-registry.ts";

export interface SweepVerdicts {
	/** Open sessions idle past the window: a retained one parks, any other closes as `idle_evicted`. */
	readonly idle: readonly string[];
	/**
	 * Sessions no client holds whose transcript directory is gone. Nothing can reopen them by path
	 * and they can never persist again, so they close as `session_dir_removed` (senpi#2206).
	 */
	readonly orphaned: readonly string[];
}

/**
 * How long a session must stand detached before the early-retirement branch may
 * park it: a disconnect that overlaps a sweep is a client about to come back,
 * and re-opening its runtime cold is the expensive path.
 */
export const DETACHED_RETIREMENT_GRACE_MS = 5_000;

/**
 * One occupancy sweep's decisions. "Idle" is the COMPLETE session-owned activity contract
 * (`AgentSession.isSessionBusy`: agent run, bash, background terminal jobs and other published
 * wake sources, compaction, barrier-held session work): a busy session restarts its idle clock
 * instead, so work that outlives a turn is never killed. A quiet detached in-process worker
 * with flushed history can reopen by path and need not keep its runtime for the idle window -
 * once it has been detached for at least `DETACHED_RETIREMENT_GRACE_MS`, so a transient
 * reconnect keeps the runtime it already owns.
 * A non-finite window evicts nothing idle.
 */
export function selectSweepEvictions(
	registry: Pick<RpcSessionRegistry, "list" | "peek">,
	now: number,
	idleEvictionMs: number,
	hasPendingRequest: (sessionId: string) => boolean = () => false,
): SweepVerdicts {
	const idle: string[] = [];
	const orphaned: string[] = [];
	for (const { sessionId, status, sessionPath } of registry.list()) {
		if (status !== "open") continue;
		const entry = registry.peek(sessionId);
		if (!entry) continue;
		if (entry.attachments === 0 && sessionPath !== undefined && sessionDirectoryRemoved(sessionPath)) {
			orphaned.push(sessionId);
			continue;
		}
		if (!Number.isFinite(idleEvictionMs)) continue;
		if (hasPendingRequest(sessionId)) continue;
		const session = entry.runtime?.session;
		if (entry.worker?.busy || session?.isSessionBusy) {
			entry.lastCommandAt = now;
			continue;
		}
		if (entry.attachments > 0) {
			// An attached client holds the live routing handle; only the ordinary deadline applies.
			if (now - entry.lastCommandAt >= idleEvictionMs) idle.push(sessionId);
			continue;
		}
		if (entry.kind === "worker" && entry.retainOnDisconnect && session?.sessionManager.isTranscriptFlushed()) {
			// Delivery debt is still owed a turn, even after the ordinary idle deadline.
			if (session.pendingMessageCount > 0 || session.externalAdmission.list().pending.length > 0) continue;
			// A just-detached worker is a client about to reconnect; park it only once the
			// disconnect has stood longer than the grace age. An entry at zero attachments
			// with no detach stamp was never disconnected, so it keeps its normal window.
			if (entry.detachedAt !== undefined) {
				if (now - entry.detachedAt < DETACHED_RETIREMENT_GRACE_MS) continue;
				idle.push(sessionId);
				continue;
			}
		}
		if (now - entry.lastCommandAt >= idleEvictionMs) idle.push(sessionId);
	}
	return { idle, orphaned };
}
