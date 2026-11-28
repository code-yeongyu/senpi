import { normalizeTurnText } from "./repetitive-turns.ts";

export const NOVELTY_MEMORY_MAX = 1024;

/**
 * Remembers the paragraphs one message has already written, compared after `normalizeTurnText` (case, whitespace,
 * digit and hex runs folded), so a counter is not new content but a recipient name is (omo#12213).
 */
export class ParagraphNovelty {
	readonly #seen = new Set<string>();

	observe(text: string): boolean {
		const key = normalizeTurnText(text);
		if (key.length === 0 || this.#seen.has(key)) return false;
		this.#seen.add(key);
		if (this.#seen.size > NOVELTY_MEMORY_MAX) {
			const oldest = this.#seen.values().next().value;
			if (oldest !== undefined) this.#seen.delete(oldest);
		}
		return true;
	}
}
