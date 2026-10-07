import { CharCode, FixedRing, isAsciiWhitespace, type ScalarEntry } from "../stream-utils.ts";
import type { DetectorMatch } from "../types.ts";
import { isAsciiAlphanumeric, isBoxDrawing } from "./collapse-scalars.ts";

export const PARAGRAPH_MIN_CHARS = 64;
export const PARAGRAPH_MIN_WORD_CHARS = 24;
export const PARAGRAPH_REPEAT_THRESHOLD = 3;
export const PARAGRAPH_RING_CAPACITY = 64;
export const PARAGRAPH_TEXT_RETENTION_MAX = 512;

const SAMPLE_LENGTH = 80;
const HASH_A_OFFSET = 0x811c9dc5;
const HASH_A_PRIME = 0x01000193;
const HASH_B_OFFSET = 5381;
const HASH_B_MULTIPLIER = 31;

interface ParagraphEntry {
	readonly hashA: number;
	readonly hashB: number;
	readonly utf16Length: number;
	readonly startOffset: number;
	readonly text: string | undefined;
}

export interface ParagraphRepeatState {
	readonly ring: FixedRing<ParagraphEntry>;
	lineHashA: number;
	lineHashB: number;
	lineLength: number;
	lineWordChars: number;
	lineHasContent: boolean;
	lineStartOffset: number;
	lineText: string;
	hashA: number;
	hashB: number;
	length: number;
	wordChars: number;
	startOffset: number;
	retained: string;
}

export function createParagraphRepeatState(): ParagraphRepeatState {
	return {
		ring: new FixedRing<ParagraphEntry>(PARAGRAPH_RING_CAPACITY),
		lineHashA: HASH_A_OFFSET,
		lineHashB: HASH_B_OFFSET,
		lineLength: 0,
		lineWordChars: 0,
		lineHasContent: false,
		lineStartOffset: 0,
		lineText: "",
		hashA: HASH_A_OFFSET,
		hashB: HASH_B_OFFSET,
		length: 0,
		wordChars: 0,
		startOffset: 0,
		retained: "",
	};
}

function isSameParagraph(a: ParagraphEntry, b: ParagraphEntry): boolean {
	return a.hashA === b.hashA && a.hashB === b.hashB && a.utf16Length === b.utf16Length;
}

function completeParagraph(state: ParagraphRepeatState): DetectorMatch | null {
	const paragraph: ParagraphEntry = {
		hashA: state.hashA,
		hashB: state.hashB,
		utf16Length: state.length,
		startOffset: state.startOffset,
		text: state.retained.length > 0 ? state.retained : undefined,
	};
	const eligible = state.length >= PARAGRAPH_MIN_CHARS && state.wordChars >= PARAGRAPH_MIN_WORD_CHARS;
	state.hashA = HASH_A_OFFSET;
	state.hashB = HASH_B_OFFSET;
	state.length = 0;
	state.wordChars = 0;
	state.startOffset = 0;
	state.retained = "";
	if (!eligible) return null;
	// Oldest -> newest, so `first` is the earliest occurrence and `second` the first repeat.
	let occurrences = 1;
	let first: ParagraphEntry | undefined;
	let second: ParagraphEntry | undefined;
	for (let back = state.ring.size - 1; back >= 0; back--) {
		const previous = state.ring.getBack(back);
		if (previous === undefined || !isSameParagraph(previous, paragraph)) continue;
		occurrences += 1;
		if (first === undefined) first = previous;
		else if (second === undefined) second = previous;
	}
	state.ring.push(paragraph);
	if (occurrences < PARAGRAPH_REPEAT_THRESHOLD || first === undefined || second === undefined) return null;
	return {
		rule: "collapse-repetition",
		reason: `paragraph repeated ${occurrences} times within one message (${paragraph.utf16Length} chars)`,
		anomalyStartOffset: first.startOffset,
		garbageStartOffset: second.startOffset,
		detail: {
			mechanism: "paragraph-repeat",
			occurrences,
			paragraphChars: paragraph.utf16Length,
			sample: (first.text ?? "").slice(0, SAMPLE_LENGTH),
		},
	};
}

export function updateParagraphRepeats(state: ParagraphRepeatState, entry: ScalarEntry): DetectorMatch | null {
	if (entry.value.charCodeAt(0) === CharCode.LineFeed) {
		let result: DetectorMatch | null = null;
		if (state.lineHasContent) {
			if (state.length === 0) state.startOffset = state.lineStartOffset;
			state.hashA = Math.imul(state.hashA ^ state.lineHashA, HASH_A_PRIME);
			state.hashB = (Math.imul(state.hashB, HASH_B_MULTIPLIER) + state.lineHashB) | 0;
			state.length += state.lineLength + 1;
			state.wordChars += state.lineWordChars;
			if (state.retained.length < PARAGRAPH_TEXT_RETENTION_MAX) state.retained += `${state.lineText}\n`;
		} else if (state.length > 0) {
			result = completeParagraph(state);
		}
		state.lineHashA = HASH_A_OFFSET;
		state.lineHashB = HASH_B_OFFSET;
		state.lineLength = 0;
		state.lineWordChars = 0;
		state.lineHasContent = false;
		state.lineStartOffset = entry.startOffset + 1;
		state.lineText = "";
		return result;
	}
	for (let i = 0; i < entry.value.length; i++) {
		const code = entry.value.charCodeAt(i);
		state.lineHashA = Math.imul(state.lineHashA ^ code, HASH_A_PRIME);
		state.lineHashB = (Math.imul(state.lineHashB, HASH_B_MULTIPLIER) + code) | 0;
	}
	const codePoint = entry.value.codePointAt(0) ?? 0;
	if (!isAsciiWhitespace(codePoint)) state.lineHasContent = true;
	if (isAsciiAlphanumeric(codePoint) || (codePoint > 0x7f && !isBoxDrawing(codePoint))) state.lineWordChars += 1;
	state.lineLength += entry.width;
	if (state.lineText.length < PARAGRAPH_TEXT_RETENTION_MAX) state.lineText += entry.value;
	return null;
}
