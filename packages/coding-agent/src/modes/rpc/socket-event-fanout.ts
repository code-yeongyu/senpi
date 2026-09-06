type SocketSink = {
	writeRaw(chunk: string): void;
	waitForBackpressure(): Promise<void>;
};

type QueueEntry = {
	line: string;
	bytes: number;
	key?: string;
	/**
	 * The record with its cumulative snapshot fields blanked (delta kept). When a
	 * later record with the same key supersedes this one, the entry is rewritten to
	 * this line instead of being replaced, so a stalled reader never loses a delta.
	 */
	demotedLine?: string;
	onWritten?: () => void;
};

// A handful of image tool results is several MiB of base64 each; four of them
// blew the previous 4 MiB cap in one burst on a healthy reader. Overflow is a
// fail-closed disconnect (the client must resync), so the cap has to be well
// above any single burst a normal session produces.
const DEFAULT_QUEUE_BYTES = 64 * 1024 * 1024;

export class SocketEventQueueOverflowError extends Error {
	readonly queuedBytes: number;
	readonly incomingBytes: number;
	readonly maxQueueBytes: number;
	readonly incomingPreview: string;

	constructor(queuedBytes: number, incomingBytes: number, maxQueueBytes: number, incomingPreview: string) {
		super(
			`socket event queue overflow: ${queuedBytes} queued + ${incomingBytes} incoming > ${maxQueueBytes} (incoming: ${incomingPreview})`,
		);
		this.name = "SocketEventQueueOverflowError";
		this.queuedBytes = queuedBytes;
		this.incomingBytes = incomingBytes;
		this.maxQueueBytes = maxQueueBytes;
		this.incomingPreview = incomingPreview;
	}
}

/** Independent FIFO actor for one socket. It never shares a drain promise with another sink. */
export class SocketEventSinkActor {
	private readonly queue: QueueEntry[] = [];
	private queuedBytes = 0;
	private draining?: Promise<void>;
	private closed = false;
	private failure?: unknown;

	private readonly sink: SocketSink;
	private readonly onFailure: (cause: unknown) => void;
	private readonly maxQueueBytes: number;

	constructor(sink: SocketSink, onFailure: (cause: unknown) => void, maxQueueBytes = DEFAULT_QUEUE_BYTES) {
		this.sink = sink;
		this.onFailure = onFailure;
		this.maxQueueBytes = maxQueueBytes;
	}

	enqueue(line: string, key?: string, onWritten?: () => void, demotedLine?: string): void {
		if (this.closed) return;
		const bytes = Buffer.byteLength(line);
		if (key !== undefined) {
			const existing = this.queue.find((entry) => entry.key === key);
			if (existing) {
				// Lossless supersession. The old behaviour replaced the queued line
				// outright, which threw away every delta a stalled reader had not yet
				// received (a desktop client assembles text from deltas). Keep the
				// superseded record - demoted to its delta-only form when the producer
				// supplied one - and let only the newest record carry the snapshot.
				if (existing.demotedLine !== undefined) {
					this.queuedBytes -= existing.bytes;
					existing.line = existing.demotedLine;
					existing.bytes = Buffer.byteLength(existing.line);
					this.queuedBytes += existing.bytes;
					existing.demotedLine = undefined;
				}
				existing.key = undefined;
			}
		}
		if (this.queuedBytes + bytes > this.maxQueueBytes) {
			const overflow = new SocketEventQueueOverflowError(
				this.queuedBytes,
				bytes,
				this.maxQueueBytes,
				line.slice(0, 120),
			);
			this.closed = true;
			this.queue.length = 0;
			this.queuedBytes = 0;
			try {
				this.sink.writeRaw(`${JSON.stringify({ type: "overflow", error: "overflow, resync required" })}\n`);
			} catch (cause) {
				this.onFailure(cause);
			}
			this.onFailure(overflow);
			return;
		}
		this.queue.push({ line, bytes, key, demotedLine, onWritten });
		this.queuedBytes += bytes;
		void this.drain();
	}

	async flush(): Promise<void> {
		while (this.draining) await this.draining;
		if (this.failure !== undefined) throw this.failure;
	}

	close(): void {
		this.closed = true;
		this.queue.length = 0;
		this.queuedBytes = 0;
	}

	private drain(): Promise<void> {
		if (this.draining) return this.draining;
		this.draining = (async () => {
			try {
				while (!this.closed && this.queue.length > 0) {
					const entry = this.queue.shift()!;
					this.queuedBytes -= entry.bytes;
					this.sink.writeRaw(entry.line);
					await this.sink.waitForBackpressure();
					entry.onWritten?.();
				}
			} catch (cause) {
				this.failure = cause;
				this.closed = true;
				this.queue.length = 0;
				this.queuedBytes = 0;
				this.onFailure(cause);
			}
		})().finally(() => {
			this.draining = undefined;
			// An enqueue that lands between the loop's exit and this reaction sees the
			// stale settled promise and starts nothing; reschedule for it here.
			if (!this.closed && this.queue.length > 0) void this.drain();
		});
		return this.draining;
	}
}
