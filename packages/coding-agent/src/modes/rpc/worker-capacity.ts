/**
 * One process's session-worker budget (`SESSION_WORKER_LIMITS.workers`), shared by every pool that starts
 * session-worker isolates: the session registry and the loopless worker pool count against the same cap
 * (Z2, senpi#5413). Each pool registers the count of workers it holds, opening ones included.
 */
export class WorkerCapacity {
	private readonly counts = new Set<() => number>();

	track(count: () => number): () => void {
		this.counts.add(count);
		return () => {
			this.counts.delete(count);
		};
	}

	inUse(): number {
		let total = 0;
		for (const count of this.counts) total += count();
		return total;
	}
}
