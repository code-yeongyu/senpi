const ASCII_WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"] as const;
const CJK_WORDS = ["漢字", "かな", "測定", "行", "東京", "서울"] as const;

export interface PercentileSummary {
	readonly p50: number;
	readonly p95: number;
}

function pickWord(words: readonly string[], index: number): string {
	return words[index % words.length] ?? "";
}

function makePlainLine(index: number): string {
	const id = String(index).padStart(5, "0");
	return `${id} plain ${pickWord(ASCII_WORDS, index)} ${pickWord(ASCII_WORDS, index + 2)} ${pickWord(ASCII_WORDS, index + 4)}`;
}

function makeAnsiLine(index: number): string {
	const id = String(index).padStart(5, "0");
	return `${id} color \x1b[36m${pickWord(ASCII_WORDS, index)} span\x1b[39m ${pickWord(ASCII_WORDS, index + 3)}`;
}

function makeCjkLine(index: number): string {
	const id = String(index).padStart(5, "0");
	return `${id} cjk ${pickWord(CJK_WORDS, index)} ${pickWord(CJK_WORDS, index + 2)} ascii tail`;
}

export function makeTranscript(n: number): string[] {
	return Array.from({ length: Math.max(0, Math.floor(n)) }, (_, index) => {
		const bucket = index % 10;
		if (bucket < 7) return makePlainLine(index);
		if (bucket < 9) return makeAnsiLine(index);
		return makeCjkLine(index);
	});
}

function percentile(samples: readonly number[], p: number): number {
	const sorted = [...samples].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[index] ?? 0;
}

export function percentiles(samples: readonly number[]): PercentileSummary {
	return {
		p50: percentile(samples, 50),
		p95: percentile(samples, 95),
	};
}
