import { serializeJsonLine } from "./jsonl.ts";

type RawWriter = (chunk: string) => void;
type FlushScheduler = (flush: () => void) => void;

/**
 * Process-wide stdout scheduler for multi-session RPC mode.
 *
 * Each queue contains complete JSONL records for one routing handle. Draining
 * takes one record per queue in round-robin order, so a busy session cannot
 * reorder another ready session's next complete record. A record is deliberately
 * written by itself: coalescing records from different sessions would obscure
 * the scheduling boundary and violate D9.
 */
export class SessionEventWriter {
	private readonly queues = new Map<string, string[]>();
	private readonly readySessions: string[] = [];
	private readonly sealedSessions = new Set<string>();
	private readonly writeRaw: RawWriter;
	private readonly scheduleFlush: FlushScheduler;
	private flushScheduled = false;
	private flushing = false;

	constructor(writeRaw: RawWriter, scheduleFlush: FlushScheduler = queueMicrotask) {
		this.writeRaw = writeRaw;
		this.scheduleFlush = scheduleFlush;
	}

	/** Queue one session-owned response, event, or extension UI request. */
	enqueue(sessionId: string, value: object): boolean {
		if (this.sealedSessions.has(sessionId)) return false;
		const queue = this.queues.get(sessionId);
		const record = serializeJsonLine({ ...value, sessionId });
		if (queue) {
			queue.push(record);
		} else {
			this.queues.set(sessionId, [record]);
			this.readySessions.push(sessionId);
		}
		this.requestFlush();
		return true;
	}

	/**
	 * Prevent subsequent records for a session and append its terminal response.
	 * Existing records retain FIFO order; this response is therefore that
	 * session's final stdout record.
	 */
	closeSession(sessionId: string, response: object): void {
		if (this.sealedSessions.has(sessionId)) return;
		this.sealedSessions.add(sessionId);
		const queue = this.queues.get(sessionId);
		const record = serializeJsonLine({ ...response, sessionId });
		if (queue) {
			queue.push(record);
		} else {
			this.queues.set(sessionId, [record]);
			this.readySessions.push(sessionId);
		}
		this.requestFlush();
	}

	/** Synchronously drain all currently complete records in fair queue order. */
	flush(): void {
		if (this.flushing) return;
		this.flushScheduled = false;
		this.flushing = true;
		try {
			while (this.readySessions.length > 0) {
				const sessionId = this.readySessions.shift()!;
				const queue = this.queues.get(sessionId);
				const record = queue?.shift();
				if (!record) continue;

				// Exactly one complete record per write. In particular, records from
				// different sessions must never share a batch.
				this.writeRaw(record);
				if (queue && queue.length > 0) {
					this.readySessions.push(sessionId);
				} else {
					this.queues.delete(sessionId);
				}
			}
		} finally {
			this.flushing = false;
		}
	}

	private requestFlush(): void {
		if (this.flushScheduled || this.flushing) return;
		this.flushScheduled = true;
		this.scheduleFlush(() => this.flush());
	}
}
