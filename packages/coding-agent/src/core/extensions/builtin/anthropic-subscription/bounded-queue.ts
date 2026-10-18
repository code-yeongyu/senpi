/**
 * Single-consumer queue with backpressure: once `capacity` values wait, the producer awaits `writable()` before it
 * reads more from its source, so a long streamed tool call never overflows it (senpi#2822).
 */
export const SESSION_STREAM_QUEUE_CAPACITY = 256;

export class BoundedAsyncQueue<T> implements AsyncIterableIterator<T> {
	private readonly capacity: number;
	private readonly values: T[] = [];
	private reader: { resolve: (result: IteratorResult<T>) => void; reject: (error: unknown) => void } | undefined;
	private writers: Array<() => void> = [];
	private closed = false;
	private failed = false;
	private failure: unknown;

	constructor(capacity: number) {
		this.capacity = capacity;
	}

	[Symbol.asyncIterator](): AsyncIterableIterator<T> {
		return this;
	}

	next(): Promise<IteratorResult<T>> {
		if (this.values.length > 0) {
			const value = this.values.shift()!;
			if (this.values.length < this.capacity) this.releaseWriters();
			return Promise.resolve({ value, done: false });
		}
		if (this.failed) return Promise.reject(this.failure);
		if (this.closed) return Promise.resolve({ value: undefined, done: true });
		return new Promise((resolve, reject) => {
			this.reader = { resolve, reject };
		});
	}

	push(value: T): void {
		if (this.closed || this.failed) return;
		const reader = this.reader;
		if (reader) {
			this.reader = undefined;
			reader.resolve({ value, done: false });
			return;
		}
		this.values.push(value);
	}

	/** Resolves once there is room for more values, or once the queue has ended. */
	writable(): Promise<void> {
		if (this.closed || this.failed || this.values.length < this.capacity) return Promise.resolve();
		return new Promise((resolve) => this.writers.push(resolve));
	}

	private releaseWriters(): void {
		for (const resolve of this.writers.splice(0)) resolve();
	}

	close(): void {
		if (this.closed || this.failed) return;
		this.closed = true;
		this.releaseWriters();
		const reader = this.reader;
		this.reader = undefined;
		reader?.resolve({ value: undefined, done: true });
	}

	fail(error: unknown): void {
		if (this.closed || this.failed) return;
		this.failed = true;
		this.failure = error;
		this.releaseWriters();
		const reader = this.reader;
		this.reader = undefined;
		reader?.reject(error);
	}
}
