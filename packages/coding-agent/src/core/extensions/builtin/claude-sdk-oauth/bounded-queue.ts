/** Single-consumer queue that fails fast instead of buffering an unbounded turn. */
export const SESSION_STREAM_QUEUE_CAPACITY = 256;

export class BoundedAsyncQueue<T> implements AsyncIterableIterator<T> {
	private readonly capacity: number;
	private readonly values: T[] = [];
	private reader: { resolve: (result: IteratorResult<T>) => void; reject: (error: unknown) => void } | undefined;
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
		if (this.values.length > 0) return Promise.resolve({ value: this.values.shift()!, done: false });
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
		if (this.values.length >= this.capacity) {
			throw new Error(`Claude SDK OAuth session stream queue exceeded ${this.capacity} messages`);
		}
		this.values.push(value);
	}

	close(): void {
		if (this.closed || this.failed) return;
		this.closed = true;
		const reader = this.reader;
		this.reader = undefined;
		reader?.resolve({ value: undefined, done: true });
	}

	fail(error: unknown): void {
		if (this.closed || this.failed) return;
		this.failed = true;
		this.failure = error;
		const reader = this.reader;
		this.reader = undefined;
		reader?.reject(error);
	}
}
