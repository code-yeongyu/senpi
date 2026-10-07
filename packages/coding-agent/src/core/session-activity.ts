/**
 * The session activity contract every occupancy decision shares.
 *
 * "Busy" means work the session OWNS that must outlive an idle-eviction
 * decision - not merely a streaming turn. There are exactly two registration
 * points for a new activity source:
 *
 * - in-session work reports a field on `SessionActivitySnapshot` (agent run,
 *   bash, compaction, the session-work barrier);
 * - work owned by an extension publishes a `wake_source_state` event with a
 *   non-zero `activeCount` (background terminal jobs, terminal monitors,
 *   loop-guard holds), which `WakeSourceTracker` folds into the same predicate.
 *
 * Callers (the shared RPC host's occupancy sweep, and anything else deciding
 * whether a session may be torn down) MUST consult `isSessionBusySnapshot()` /
 * `AgentSession.isSessionBusy` instead of testing individual flags, so a source
 * added later cannot be silently missed by one call site.
 */

/** Live counts of extension-published wake sources, keyed by source name. */
export class WakeSourceTracker {
	private readonly counts = new Map<string, number>();

	/**
	 * Folds one `wake_source_state` payload in. Unknown shapes are ignored: a
	 * malformed publisher must never flip a session to "idle" by accident.
	 */
	observe(data: unknown): void {
		if (typeof data !== "object" || data === null) return;
		const { source, activeCount } = data as { source?: unknown; activeCount?: unknown };
		if (typeof source !== "string" || source.length === 0) return;
		if (typeof activeCount !== "number" || !Number.isFinite(activeCount)) return;
		if (activeCount > 0) this.counts.set(source, activeCount);
		else this.counts.delete(source);
	}

	/** Whether any published source currently reports live work. */
	get hasActive(): boolean {
		return this.counts.size > 0;
	}

	/** Sources reporting live work, for diagnostics. */
	get activeSources(): readonly string[] {
		return [...this.counts.keys()];
	}
}

/** In-session activity signals. Every field means "work that must not be evicted". */
export interface SessionActivitySnapshot {
	/** An agent run or post-run continuation is active. */
	readonly isStreaming: boolean;
	/** A bash command owned by this session is running. */
	readonly isBashRunning: boolean;
	/** Compaction or branch summarization is running. */
	readonly isCompacting: boolean;
	/** The session-work barrier holds deferred work (queued continuations, rebinds). */
	readonly hasSessionWork: boolean;
	/** An extension-published wake source reports live work. */
	readonly hasActiveWakeSource: boolean;
}

/** The complete session-owned activity predicate. */
export function isSessionBusySnapshot(snapshot: SessionActivitySnapshot): boolean {
	return (
		snapshot.isStreaming ||
		snapshot.isBashRunning ||
		snapshot.isCompacting ||
		snapshot.hasSessionWork ||
		snapshot.hasActiveWakeSource
	);
}
