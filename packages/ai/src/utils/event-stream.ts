import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";
import {
	type AssistantProgress,
	type CaptureHint,
	captureAssistantEvent,
	dropAssistantCapture,
	enableAssistantCapture,
	setAssistantProgressWriter,
	setAssistantReader,
} from "./assistant-capture.ts";

type OrderedEntry<T> = { event: T } | { progress: AssistantProgress };

class FifoQueue<T> {
	private incoming: T[] = [];
	private outgoing: T[] = [];

	get length(): number {
		return this.incoming.length + this.outgoing.length;
	}

	enqueue(value: T): void {
		this.incoming.push(value);
	}

	prepend(value: T): void {
		this.outgoing.push(value);
	}

	dequeue(): T | undefined {
		if (this.outgoing.length === 0) {
			while (this.incoming.length > 0) {
				this.outgoing.push(this.incoming.pop()!);
			}
		}
		return this.outgoing.pop();
	}
}

// Generic event stream class for async iteration
export class EventStream<T, R = T> implements AsyncIterable<T> {
	#queue: OrderedEntry<T>[] = [];
	#queueHead = 0;
	private waiting = new FifoQueue<{
		resolve: (value: IteratorResult<OrderedEntry<T>>) => void;
		reject: (error: unknown) => void;
	}>();
	protected done = false;
	#failed = false;
	#error: unknown;
	#localWorkDepth = 0;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;
	private rejectFinalResult!: (error: unknown) => void;
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.finalResultPromise = new Promise((resolve, reject) => {
			this.resolveFinalResult = resolve;
			this.rejectFinalResult = reject;
		});
		this.finalResultPromise.catch(() => {});
	}

	get queue(): T[] {
		return this.#queue.slice(this.#queueHead).flatMap((entry) => ("event" in entry ? [entry.event] : []));
	}

	#enqueue(event: OrderedEntry<T>): void {
		this.#queue.push(event);
	}

	#dequeue(): OrderedEntry<T> {
		const event = this.#queue[this.#queueHead];
		if (event === undefined) {
			throw new Error("EventStream queue underflow");
		}
		this.#queueHead++;
		if (this.#queueHead > 1024 && this.#queueHead * 2 >= this.#queue.length) {
			this.#queue = this.#queue.slice(this.#queueHead);
			this.#queueHead = 0;
		}
		return event;
	}

	push(event: T): void {
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		this.#deliver({ event });
	}

	protected enqueueProgress(progress: AssistantProgress): void {
		if (!this.done) this.#deliver({ progress });
	}

	#deliver(entry: OrderedEntry<T>): void {
		const waiter = this.waiting.dequeue();
		if (waiter) {
			waiter.resolve({ value: entry, done: false });
		} else {
			this.#enqueue(entry);
		}
	}

	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		// Notify all waiting consumers that we're done
		while (this.waiting.length > 0) {
			const waiter = this.waiting.dequeue();
			if (waiter) waiter.resolve({ value: undefined, done: true });
		}
	}

	fail(error: unknown): void {
		if (this.done) return;
		this.done = true;
		this.#failed = true;
		this.#error = error;
		this.rejectFinalResult(error);
		while (this.waiting.length > 0) {
			const waiter = this.waiting.dequeue();
			if (waiter) waiter.reject(error);
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return this.mapIterator((entry) => ("event" in entry ? { value: entry.event, done: false } : undefined));
	}

	protected mapIterator<V>(project: (entry: OrderedEntry<T>) => IteratorResult<V> | undefined): AsyncIterator<V> {
		return {
			next: () => {
				while (this.#queueHead < this.#queue.length) {
					const result = project(this.#dequeue());
					if (result) return Promise.resolve(result);
				}
				if (this.#failed) {
					return Promise.reject(this.#error);
				}
				if (this.done) {
					return Promise.resolve({ value: undefined, done: true });
				}
				return new Promise<IteratorResult<V>>((resolve, reject) => {
					const waiter = {
						reject,
						resolve: (next: IteratorResult<OrderedEntry<T>>) => {
							const result = next.done ? { value: undefined, done: true as const } : project(next.value);
							if (result) resolve(result);
							else this.waiting.prepend(waiter);
						},
					};
					this.waiting.enqueue(waiter);
				});
			},
		};
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}

	/**
	 * Track a locally executing unit of work (for example a server-requested
	 * tool run on Cursor's exec channel) during which the stream legitimately
	 * emits no events. Idle watchdogs consult {@link hasPendingLocalWork} to
	 * attribute the silence to the tool run instead of aborting a healthy
	 * stream. Rejections propagate to the caller unchanged.
	 */
	async trackLocalWork<TWork>(work: Promise<TWork>): Promise<TWork> {
		this.#localWorkDepth++;
		try {
			return await work;
		} finally {
			this.#localWorkDepth--;
		}
	}

	/** True while at least one {@link trackLocalWork} promise is unsettled. */
	hasPendingLocalWork(): boolean {
		return this.#localWorkDepth > 0;
	}
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor(options: { readonly captureBlocks?: boolean } = {}) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
		if (options.captureBlocks) enableAssistantCapture(this);
		setAssistantProgressWriter(this, (progress) => this.enqueueProgress(progress));
		// A subclass that replaces iteration (cancellation, snapshots, remapping) stays unaware unless it registers a reader;
		// one that remaps contentIndex in push must register its own reader too, or progress keeps the unmapped indices.
		if (new.target.prototype[Symbol.asyncIterator] === AssistantMessageEventStream.prototype[Symbol.asyncIterator])
			setAssistantReader(this, (project) => this.mapIterator(project));
	}

	override push(event: AssistantMessageEvent, hint?: CaptureHint): void {
		if (this.done) return;
		captureAssistantEvent(this, event, hint);
		super.push(event);
	}

	override [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		return this.mapIterator((entry) => {
			if (!("event" in entry)) return undefined;
			// Unaware wrappers may snapshot, remap, buffer or discard this event. Never forward its carrier.
			dropAssistantCapture(entry.event);
			return { value: entry.event, done: false };
		});
	}
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
