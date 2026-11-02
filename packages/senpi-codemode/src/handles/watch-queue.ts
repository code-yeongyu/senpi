import type { HandleSnapshot, HandleWatch } from "@code-yeongyu/senpi";
import { refKey } from "./handle-args.ts";

/**
 * A pull-side buffer for handle snapshots. Pushes queue up until the consumer iterates, so a change
 * that lands between subscription and `initial` is delivered exactly once; `close()` is idempotent
 * and ends the iterator.
 */
export class WatchQueue {
	readonly #keys: ReadonlySet<string> | undefined;
	readonly #queue: HandleSnapshot[] = [];
	#wake: (() => void) | undefined;
	#closed = false;
	#failure: unknown;
	#failed = false;

	/** Without keys every snapshot is accepted (used by the merger); with keys only matching refs are. */
	constructor(keys?: readonly string[]) {
		this.#keys = keys === undefined ? undefined : new Set(keys);
	}

	get closed(): boolean {
		return this.#closed;
	}

	push(snapshot: HandleSnapshot): void {
		if (this.#closed || (this.#keys !== undefined && !this.#keys.has(refKey(snapshot.ref)))) return;
		this.#queue.push(snapshot);
		this.#wake?.();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#wake?.();
	}

	/** Ends the stream with an error: the next pull rejects instead of reporting a clean end. */
	fail(error: unknown): void {
		if (this.#closed) return;
		this.#failed = true;
		this.#failure = error;
		this.close();
	}

	toWatch(initial: readonly HandleSnapshot[], onClose?: () => void): HandleWatch {
		const close = (): void => {
			this.close();
			onClose?.();
		};
		const next = async (): Promise<IteratorResult<HandleSnapshot>> => {
			while (this.#queue.length === 0 && !this.#closed) {
				await new Promise<void>((resolve) => {
					this.#wake = resolve;
				});
			}
			this.#wake = undefined;
			const value = this.#queue.shift();
			if (value !== undefined) return { done: false, value };
			if (this.#failed) throw this.#failure;
			return { done: true, value: undefined };
		};
		const updates: AsyncIterable<HandleSnapshot> = {
			[Symbol.asyncIterator]: () => ({
				next,
				return: async (): Promise<IteratorResult<HandleSnapshot>> => {
					close();
					return { done: true, value: undefined };
				},
			}),
		};
		return { initial, updates, close };
	}
}

/** One watch over several: `initial` keeps the caller's order, updates from every part are drained eagerly. */
export function mergeWatches(ordered: readonly HandleSnapshot[], parts: readonly HandleWatch[]): HandleWatch {
	if (parts.length === 1 && parts[0] !== undefined) return { ...parts[0], initial: ordered };
	const queue = new WatchQueue();
	let open = parts.length;
	const drain = async (part: HandleWatch): Promise<void> => {
		try {
			for await (const snapshot of part.updates) queue.push(snapshot);
		} catch (error) {
			queue.fail(error);
		} finally {
			open -= 1;
			if (open === 0) queue.close();
		}
	};
	if (parts.length === 0) queue.close();
	for (const part of parts) void drain(part);
	const merged = queue.toWatch(ordered);
	return {
		initial: merged.initial,
		updates: merged.updates,
		close: () => {
			for (const part of parts) part.close();
			merged.close();
		},
	};
}
