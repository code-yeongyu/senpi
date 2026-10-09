import type { RpcSessionRegistryError } from "./session-registry.ts";
import { SESSION_WORKER_LIMITS, type SessionWriteGrant } from "./session-worker-protocol.ts";

/** What a worker still writes: the paths of its live session writers plus its current session path. */
export interface LiveWorkerPaths {
	readonly livePaths: readonly string[];
	readonly sessionPath?: string;
}

/** Wire code each denial is reported with; distinct so clients can retry only the retryable one. */
export const RESERVATION_DENIAL_CODES = {
	conflict: "session_path_in_use",
	limit: "session_reservation_limit",
} as const satisfies Record<Exclude<SessionWriteGrant, "granted">, RpcSessionRegistryError["code"]>;

/**
 * Canonical session-path ownership for the shared host: one path, one worker handle.
 *
 * A grant lives as long as the writer that holds it. Reconciliation against a worker's
 * reported live writers releases superseded paths, so a session replaced by /new, /resume
 * or /fork no longer keeps its previous file hostage or spends the per-worker budget.
 */
export class SessionPathReservations {
	private readonly owners = new Map<string, string>();

	owner(path: string): string | undefined {
		return this.owners.get(path);
	}

	count(handle: string): number {
		let count = 0;
		for (const owner of this.owners.values()) if (owner === handle) count++;
		return count;
	}

	/** Grants `path` to `handle`; at the budget cap, the live view first releases superseded paths. */
	reserve(handle: string, path: string, live?: LiveWorkerPaths): SessionWriteGrant {
		const owner = this.owners.get(path);
		if (owner) return owner === handle ? "granted" : "conflict";
		if (this.count(handle) >= SESSION_WORKER_LIMITS.reservations) {
			if (!live) return "limit";
			this.reconcile(handle, live);
			if (this.count(handle) >= SESSION_WORKER_LIMITS.reservations) return "limit";
		}
		this.owners.set(path, handle);
		return "granted";
	}

	/** Releases every path of `handle` that none of its live writers owns anymore. */
	reconcile(handle: string, live: LiveWorkerPaths): void {
		for (const [path, owner] of this.owners) {
			if (owner !== handle || path === live.sessionPath || live.livePaths.includes(path)) continue;
			this.owners.delete(path);
		}
	}

	/** Drops the whole budget of a handle; only a real worker exit may call this. */
	releaseAll(handle: string): void {
		for (const [path, owner] of this.owners) if (owner === handle) this.owners.delete(path);
	}
}
