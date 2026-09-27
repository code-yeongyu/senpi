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
 * One occupancy sweep's decisions. "Idle" is the COMPLETE session-owned activity contract
 * (`AgentSession.isSessionBusy`: agent run, bash, background terminal jobs and other published
 * wake sources, compaction, barrier-held session work): a busy session restarts its idle clock
 * instead, so work that outlives a turn is never killed. A non-finite window evicts nothing idle.
 */
export function selectSweepEvictions(
	registry: Pick<RpcSessionRegistry, "list" | "peek">,
	now: number,
	idleEvictionMs: number,
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
		if (entry.worker?.busy || entry.runtime?.session.isSessionBusy) {
			entry.lastCommandAt = now;
			continue;
		}
		if (now - entry.lastCommandAt >= idleEvictionMs) idle.push(sessionId);
	}
	return { idle, orphaned };
}
