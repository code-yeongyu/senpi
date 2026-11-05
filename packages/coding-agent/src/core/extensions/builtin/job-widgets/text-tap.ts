/**
 * Text appended over time and kept as its newest `capacity` UTF-16 units, readable from any
 * retained offset: a bash job's own output, or a subagent's finished tool results.
 * Ported from oh-my-pi 9df0457b31 (MIT, Copyright Can Boluk et al.).
 */
import type { JobTextChunk, JobTextSource } from "./source-types.ts";

const DEFAULT_CAPACITY = 256 * 1024;

export class TextTap implements JobTextSource {
	readonly id: string;
	readonly label: string;
	readonly #capacity: number;
	#text = "";
	/** Offset of `#text[0]`. */
	#start = 0;
	#open = true;

	constructor(id: string, label: string, capacity = DEFAULT_CAPACITY) {
		this.id = id;
		this.label = label;
		this.#capacity = Math.max(1, capacity);
	}

	append(text: string): void {
		if (!this.#open || text.length === 0) return;
		this.#text += text;
		// Trimmed in batches so a stream of small appends does not copy the retained text every chunk.
		const excess = this.#text.length - this.#capacity;
		if (excess > this.#capacity / 4) {
			this.#text = this.#text.slice(excess);
			this.#start += excess;
		}
	}

	/** No more text will arrive. */
	close(): void {
		this.#open = false;
	}

	read(from: number): JobTextChunk {
		const end = this.#start + this.#text.length;
		const kept = Math.max(this.#start, end - this.#capacity);
		const start = Math.min(Math.max(from, kept), end);
		return { start, end, text: this.#text.slice(start - this.#start), open: this.#open };
	}
}
