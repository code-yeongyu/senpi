export interface BtwHistoryViewEntry {
	question: string;
	answer: string;
}

export class BtwHistoryViewModel {
	readonly #entries: readonly BtwHistoryViewEntry[];
	#selectedIndex = 0;
	#scrollOffset = 0;
	#answerLineCount = 0;
	#viewportHeight = 0;

	constructor(entries: readonly BtwHistoryViewEntry[]) {
		this.#entries = entries;
	}

	get entryCount(): number {
		return this.#entries.length;
	}

	get selectedIndex(): number {
		return this.#selectedIndex;
	}

	get scrollOffset(): number {
		return this.#scrollOffset;
	}

	get selected(): BtwHistoryViewEntry | undefined {
		return this.#entries[this.#selectedIndex];
	}

	selectPrevious(): boolean {
		if (this.entryCount === 0 || this.#selectedIndex === 0) return false;
		this.#selectedIndex -= 1;
		this.#scrollOffset = 0;
		return true;
	}

	selectNext(): boolean {
		if (this.entryCount === 0 || this.#selectedIndex >= this.entryCount - 1) return false;
		this.#selectedIndex += 1;
		this.#scrollOffset = 0;
		return true;
	}

	scrollUp(): boolean {
		if (this.#scrollOffset === 0) return false;
		this.#scrollOffset -= 1;
		return true;
	}

	scrollDown(): boolean {
		if (this.#scrollOffset >= this.maxScrollOffset) return false;
		this.#scrollOffset += 1;
		return true;
	}

	setAnswerLineCount(count: number): void {
		this.#answerLineCount = count;
		this.#clampScrollOffset();
	}

	setViewportHeight(height: number): void {
		this.#viewportHeight = height;
		this.#clampScrollOffset();
	}

	get maxScrollOffset(): number {
		if (this.entryCount === 0) return 0;
		return Math.max(0, this.#answerLineCount - this.#viewportHeight);
	}

	#clampScrollOffset(): void {
		this.#scrollOffset = Math.min(this.#scrollOffset, this.maxScrollOffset);
	}
}
