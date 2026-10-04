import type { HandleRef, HandleSnapshot, HandleWatch } from "../../../src/index.ts";
import { refKey } from "./eval-handle-host-state.ts";

/**
 * A fake subscription: snapshots pushed by the host queue up until the consumer pulls them, so a change
 * that lands while `watch()` is still assembling `initial` is delivered exactly once. `close()` is
 * idempotent and ends the iterator.
 */
export class FakeWatchQueue {
	readonly #keys: ReadonlySet<string>;
	readonly #queue: HandleSnapshot[] = [];
	#wake: (() => void) | undefined;
	#closed = false;

	constructor(refs: readonly HandleRef[]) {
		this.#keys = new Set(refs.map(refKey));
	}

	get closed(): boolean {
		return this.#closed;
	}

	push(snapshot: HandleSnapshot): void {
		if (this.#closed || !this.#keys.has(refKey(snapshot.ref))) return;
		this.#queue.push(snapshot);
		this.#wake?.();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#wake?.();
	}

	toWatch(initial: readonly HandleSnapshot[]): HandleWatch {
		const close = (): void => this.close();
		const next = async (): Promise<IteratorResult<HandleSnapshot>> => {
			while (this.#queue.length === 0 && !this.#closed) {
				await new Promise<void>((resolve) => {
					this.#wake = resolve;
				});
			}
			this.#wake = undefined;
			const value = this.#queue.shift();
			return value === undefined ? { done: true, value: undefined } : { done: false, value };
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
