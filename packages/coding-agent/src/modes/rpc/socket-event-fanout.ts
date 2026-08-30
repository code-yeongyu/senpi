type SocketSink = {
	writeRaw(chunk: string): void;
	waitForBackpressure(): Promise<void>;
};

type QueueEntry = { line: string; bytes: number; key?: string; onWritten?: () => void };

const DEFAULT_QUEUE_BYTES = 4 * 1024 * 1024;

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

	enqueue(line: string, key?: string, onWritten?: () => void): void {
		if (this.closed) return;
		const bytes = Buffer.byteLength(line);
		if (key !== undefined) {
			const existing = this.queue.find((entry) => entry.key === key);
			if (existing) {
				this.queuedBytes += bytes - existing.bytes;
				existing.line = line;
				existing.bytes = bytes;
				if (this.queuedBytes <= this.maxQueueBytes) return;
			}
		}
		if (this.queuedBytes + bytes > this.maxQueueBytes) {
			this.closed = true;
			this.queue.length = 0;
			this.queuedBytes = 0;
			try {
				this.sink.writeRaw(`${JSON.stringify({ type: "overflow", error: "overflow, resync required" })}\n`);
			} catch (cause) {
				this.onFailure(cause);
			}
			this.onFailure(new Error("socket event queue overflow"));
			return;
		}
		this.queue.push({ line, bytes, key, onWritten });
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
