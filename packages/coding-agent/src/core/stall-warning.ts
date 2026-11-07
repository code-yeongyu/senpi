/**
 * Deadline-bounded warnings for waits that have no deadline of their own (senpi#6189).
 *
 * A wait that never settles leaves no trace: no timer fires, no result is written, and the
 * session just idles. These helpers only observe such a wait. They log once when it outlives
 * its threshold and never resolve, reject, abort or delay anything themselves.
 */

/** A wait still pending after this long is logged once. A call's own shorter timeout lowers it. */
export const STALL_WARNING_MS = 30_000;

/** The warning threshold for a call whose own `timeout` (in seconds) may be shorter than {@link STALL_WARNING_MS}. */
export function stallThresholdMs(timeoutSeconds: unknown): number {
	if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
		return STALL_WARNING_MS;
	}
	return Math.max(1, Math.min(STALL_WARNING_MS, Math.trunc(timeoutSeconds * 1000)));
}

export function toolCallTimeout(args: unknown): unknown {
	return typeof args === "object" && args !== null ? (args as { timeout?: unknown }).timeout : undefined;
}

export function queueEntryLabel(event: { readonly type: string }): string {
	const toolCallId = (event as { toolCallId?: unknown }).toolCallId;
	return typeof toolCallId === "string" ? `${event.type}:${toolCallId}` : event.type;
}

export interface StallWatch {
	stop(): void;
}

/**
 * Call `onStall` once if `stop` has not run within `thresholdMs`. The caller keeps its own `await`, so the
 * watched wait's outcome and ordering are unchanged. The timer is unref'd: it never keeps the process alive.
 */
export function watchForStall(thresholdMs: number, onStall: (elapsedMs: number) => void): StallWatch {
	const startedAt = Date.now();
	const timer = setTimeout(() => onStall(Date.now() - startedAt), thresholdMs);
	timer.unref?.();
	return { stop: () => clearTimeout(timer) };
}

export interface PendingQueueSnapshot {
	readonly queueDepth: number;
	/** Label of the oldest unsettled entry: the one every later entry waits behind. */
	readonly queueHead?: string;
	readonly ageMs?: number;
}

/** The unsettled entries of a promise chain, oldest first, so a stalled wait on the chain can name what it waits behind. */
export class PendingQueueLedger {
	private nextId = 0;
	private readonly entries = new Map<number, { readonly label: string; readonly enqueuedAt: number }>();

	track(label: string, settles: Promise<unknown>): void {
		const id = this.nextId++;
		this.entries.set(id, { label, enqueuedAt: Date.now() });
		const release = () => {
			this.entries.delete(id);
		};
		void settles.then(release, release);
	}

	snapshot(): PendingQueueSnapshot {
		const head = this.entries.values().next().value;
		if (head === undefined) return { queueDepth: 0 };
		return { queueDepth: this.entries.size, queueHead: head.label, ageMs: Date.now() - head.enqueuedAt };
	}
}
