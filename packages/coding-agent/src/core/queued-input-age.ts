export interface OutlivedQueuedInput {
	readonly queuedId: string;
	readonly ageMs: number;
}

interface QueuedAt {
	readonly runsStarted: number;
	readonly atMs: number;
}

/**
 * Tracks when each queued input was queued relative to turns, so input that outlives a completed turn is reported
 * instead of waiting silently (senpi#4036). The caller counts a turn once when it starts (not per retry or internal
 * continuation) and checks only turns that ended normally: steers are taken at the turn's boundaries and follow-ups
 * when it finishes, while a failed or aborted turn keeps its queue for the next prompt by design.
 */
export class QueuedInputAges {
	#runsStarted = 0;
	readonly #queuedAt = new Map<string, QueuedAt>();
	readonly #reported = new Set<string>();

	noteRunStarted(): void {
		this.#runsStarted += 1;
	}

	noteQueued(queuedId: string, nowMs: number): void {
		this.#queuedAt.set(queuedId, { runsStarted: this.#runsStarted, atMs: nowMs });
	}

	takeOutlived(stillQueued: readonly string[], nowMs: number): OutlivedQueuedInput[] {
		const live = new Set(stillQueued);
		for (const queuedId of this.#queuedAt.keys()) {
			if (live.has(queuedId)) continue;
			this.#queuedAt.delete(queuedId);
			this.#reported.delete(queuedId);
		}
		const outlived: OutlivedQueuedInput[] = [];
		for (const queuedId of stillQueued) {
			const queuedAt = this.#queuedAt.get(queuedId);
			if (queuedAt === undefined || this.#reported.has(queuedId)) continue;
			if (queuedAt.runsStarted >= this.#runsStarted) continue;
			this.#reported.add(queuedId);
			outlived.push({ queuedId, ageMs: nowMs - queuedAt.atMs });
		}
		return outlived;
	}
}
