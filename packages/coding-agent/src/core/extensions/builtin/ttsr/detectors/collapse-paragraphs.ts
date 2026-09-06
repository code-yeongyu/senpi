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
const NUMBER_SENTINEL = 0x110000;
const MAX_NORMALIZED_DIGIT_RUN = 32;
const MAX_NORMALIZED_NUMERIC_RUNS_PER_PARAGRAPH = 2;

interface ParagraphEntry {
	readonly hashA: number;
	readonly hashB: number;
	readonly utf16Length: number;
	readonly normalizedHashA: number;
	readonly normalizedHashB: number;
	readonly normalizedLength: number;
	readonly normalizationSafe: boolean;
	readonly progressEpoch: number | undefined;
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
	lineNormalizedHashA: number;
	lineNormalizedHashB: number;
	lineNormalizedLength: number;
	lineNormalizationSafe: boolean;
	linePreviousWasWhitespace: boolean;
	numberRun: string;
	numberRunStartsAfterWhitespace: boolean;
	numberRunAtLineStart: boolean;
	codeFence: { readonly marker: "`" | "~"; readonly length: number } | undefined;
	hashA: number;
	hashB: number;
	length: number;
	wordChars: number;
	startOffset: number;
	retained: string;
	normalizedHashA: number;
	normalizedHashB: number;
	normalizedLength: number;
	normalizationSafe: boolean;
	progressEpoch: number | undefined;
	numericRunCount: number;
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
		lineNormalizedHashA: HASH_A_OFFSET,
		lineNormalizedHashB: HASH_B_OFFSET,
		lineNormalizedLength: 0,
		lineNormalizationSafe: true,
		linePreviousWasWhitespace: true,
		numberRun: "",
		numberRunStartsAfterWhitespace: false,
		numberRunAtLineStart: false,
		codeFence: undefined,
		hashA: HASH_A_OFFSET,
		hashB: HASH_B_OFFSET,
		length: 0,
		wordChars: 0,
		startOffset: 0,
		retained: "",
		normalizedHashA: HASH_A_OFFSET,
		normalizedHashB: HASH_B_OFFSET,
		normalizedLength: 0,
		normalizationSafe: true,
		progressEpoch: undefined,
		numericRunCount: 0,
	};
}

function isSameParagraph(a: ParagraphEntry, b: ParagraphEntry): boolean {
	return a.hashA === b.hashA && a.hashB === b.hashB && a.utf16Length === b.utf16Length;
}

function isSameNormalizedParagraph(a: ParagraphEntry, b: ParagraphEntry): boolean {
	return (
		a.normalizationSafe &&
		b.normalizationSafe &&
		a.progressEpoch === b.progressEpoch &&
		a.normalizedHashA === b.normalizedHashA &&
		a.normalizedHashB === b.normalizedHashB &&
		a.normalizedLength === b.normalizedLength
	);
}

function appendNormalizedCode(state: ParagraphRepeatState, code: number): void {
	state.lineNormalizedHashA = Math.imul(state.lineNormalizedHashA ^ code, HASH_A_PRIME);
	state.lineNormalizedHashB = (Math.imul(state.lineNormalizedHashB, HASH_B_MULTIPLIER) + code) | 0;
	state.lineNormalizedLength += 1;
}

function appendNormalizedText(state: ParagraphRepeatState, value: string): void {
	for (let index = 0; index < value.length; index++) appendNormalizedCode(state, value.charCodeAt(index));
}

function flushNumberRun(state: ParagraphRepeatState, nextIsWhitespace: boolean): void {
	if (state.numberRun.length === 0) return;
	const normalize = state.lineNormalizationSafe && state.numberRunStartsAfterWhitespace && nextIsWhitespace;
	if (normalize) {
		appendNormalizedCode(state, NUMBER_SENTINEL);
	} else {
		appendNormalizedText(state, state.numberRun);
	}
	state.numberRun = "";
	state.numberRunStartsAfterWhitespace = false;
	state.numberRunAtLineStart = false;
}

function resetLine(state: ParagraphRepeatState, startOffset: number): void {
	state.lineHashA = HASH_A_OFFSET;
	state.lineHashB = HASH_B_OFFSET;
	state.lineLength = 0;
	state.lineWordChars = 0;
	state.lineHasContent = false;
	state.lineStartOffset = startOffset;
	state.lineText = "";
	state.lineNormalizedHashA = HASH_A_OFFSET;
	state.lineNormalizedHashB = HASH_B_OFFSET;
	state.lineNormalizedLength = 0;
	state.lineNormalizationSafe = true;
	state.linePreviousWasWhitespace = true;
	state.numberRun = "";
	state.numberRunStartsAfterWhitespace = false;
	state.numberRunAtLineStart = false;
}

function resetParagraph(state: ParagraphRepeatState): void {
	state.hashA = HASH_A_OFFSET;
	state.hashB = HASH_B_OFFSET;
	state.length = 0;
	state.wordChars = 0;
	state.startOffset = 0;
	state.retained = "";
	state.normalizedHashA = HASH_A_OFFSET;
	state.normalizedHashB = HASH_B_OFFSET;
	state.normalizedLength = 0;
	state.normalizationSafe = true;
	state.progressEpoch = undefined;
	state.numericRunCount = 0;
}

function completeParagraph(state: ParagraphRepeatState): DetectorMatch | null {
	const paragraph: ParagraphEntry = {
		hashA: state.hashA,
		hashB: state.hashB,
		utf16Length: state.length,
		normalizedHashA: state.normalizedHashA,
		normalizedHashB: state.normalizedHashB,
		normalizedLength: state.normalizedLength,
		normalizationSafe: state.normalizationSafe,
		progressEpoch: state.progressEpoch,
		startOffset: state.startOffset,
		text: state.retained.length > 0 ? state.retained : undefined,
	};
	const eligible = state.length >= PARAGRAPH_MIN_CHARS && state.wordChars >= PARAGRAPH_MIN_WORD_CHARS;
	resetParagraph(state);
	if (!eligible) return null;

	const exactMatches: ParagraphEntry[] = [];
	const normalizedMatches: ParagraphEntry[] = [];
	for (let back = state.ring.size - 1; back >= 0; back--) {
		const previous = state.ring.getBack(back);
		if (previous === undefined) continue;
		if (isSameParagraph(previous, paragraph)) exactMatches.push(previous);
		if (isSameNormalizedParagraph(previous, paragraph)) normalizedMatches.push(previous);
	}
	const normalized = exactMatches.length < PARAGRAPH_REPEAT_THRESHOLD - 1;
	const matches = normalized ? normalizedMatches : exactMatches;
	state.ring.push(paragraph);
	if (matches.length < PARAGRAPH_REPEAT_THRESHOLD - 1) return null;
	const [first, second] = matches;
	if (first === undefined || second === undefined) return null;
	const occurrences = matches.length + 1;
	return {
		rule: "collapse-repetition",
		reason: `paragraph repeated ${occurrences} times within one message (${paragraph.utf16Length} chars)`,
		anomalyStartOffset: first.startOffset,
		garbageStartOffset: second.startOffset,
		detail: {
			mechanism: "paragraph-repeat",
			occurrences,
			paragraphChars: paragraph.utf16Length,
			...(normalized ? { normalized: true } : {}),
			sample: (first.text ?? "").slice(0, SAMPLE_LENGTH),
		},
	};
}

function noteProgressEpoch(state: ParagraphRepeatState, progressEpoch: number): void {
	if (state.progressEpoch === undefined) {
		state.progressEpoch = progressEpoch;
	} else if (state.progressEpoch !== progressEpoch) {
		state.normalizationSafe = false;
	}
}

function updateLineSafety(state: ParagraphRepeatState): void {
	const fenceMatch = /^[\t ]*(`{3,}|~{3,})/.exec(state.lineText);
	const fence = fenceMatch?.[1];
	const marker = fence?.[0];
	if (state.codeFence !== undefined) {
		state.lineNormalizationSafe = false;
		if (
			fenceMatch !== null &&
			fence !== undefined &&
			marker === state.codeFence.marker &&
			fence.length >= state.codeFence.length &&
			state.lineLength === state.lineText.length &&
			state.lineText.slice(fenceMatch[0].length).trim().length === 0
		) {
			state.codeFence = undefined;
		}
	} else if (fence !== undefined && (marker === "`" || marker === "~")) {
		state.lineNormalizationSafe = false;
		state.codeFence = { marker, length: fence.length };
	}
	if (/\b(?:step|phase|item)\s+\d+\s+of\b/i.test(state.lineText)) state.lineNormalizationSafe = false;
}

function updateNormalizedLine(state: ParagraphRepeatState, entry: ScalarEntry, lineWasEmpty: boolean): void {
	const codePoint = entry.value.codePointAt(0) ?? 0;
	const isDigit = codePoint >= 48 && codePoint <= 57;
	if (isDigit) {
		if (state.numberRun.length === 0) {
			state.numberRunStartsAfterWhitespace = state.linePreviousWasWhitespace;
			state.numberRunAtLineStart = lineWasEmpty;
			state.numericRunCount += 1;
			if (state.numericRunCount > MAX_NORMALIZED_NUMERIC_RUNS_PER_PARAGRAPH) {
				state.normalizationSafe = false;
			}
		}
		if (state.numberRun.length < MAX_NORMALIZED_DIGIT_RUN) {
			state.numberRun += entry.value;
		} else {
			state.lineNormalizationSafe = false;
		}
		state.linePreviousWasWhitespace = false;
		return;
	}

	if (state.numberRunAtLineStart && (entry.value === "." || entry.value === ")")) state.lineNormalizationSafe = false;
	flushNumberRun(state, isAsciiWhitespace(codePoint));
	if (entry.value === "`" || ";={}[]*/^".includes(entry.value)) state.lineNormalizationSafe = false;
	appendNormalizedText(state, entry.value);
	state.linePreviousWasWhitespace = isAsciiWhitespace(codePoint);
}

export function updateParagraphRepeats(
	state: ParagraphRepeatState,
	entry: ScalarEntry,
	progressEpoch = 0,
): DetectorMatch | null {
	if (entry.value.charCodeAt(0) === CharCode.LineFeed) {
		let result: DetectorMatch | null = null;
		if (state.lineHasContent) {
			updateLineSafety(state);
			flushNumberRun(state, true);
			if (state.length === 0) state.startOffset = state.lineStartOffset;
			state.hashA = Math.imul(state.hashA ^ state.lineHashA, HASH_A_PRIME);
			state.hashB = (Math.imul(state.hashB, HASH_B_MULTIPLIER) + state.lineHashB) | 0;
			state.length += state.lineLength + 1;
			state.wordChars += state.lineWordChars;
			if (state.retained.length < PARAGRAPH_TEXT_RETENTION_MAX) state.retained += `${state.lineText}\n`;
			state.normalizedHashA = Math.imul(state.normalizedHashA ^ state.lineNormalizedHashA, HASH_A_PRIME);
			state.normalizedHashB = (Math.imul(state.normalizedHashB, HASH_B_MULTIPLIER) + state.lineNormalizedHashB) | 0;
			state.normalizedLength += state.lineNormalizedLength + 1;
			state.normalizationSafe &&= state.lineNormalizationSafe;
		} else if (state.length > 0) {
			result = completeParagraph(state);
		}
		resetLine(state, entry.startOffset + 1);
		return result;
	}

	for (let index = 0; index < entry.value.length; index++) {
		const code = entry.value.charCodeAt(index);
		state.lineHashA = Math.imul(state.lineHashA ^ code, HASH_A_PRIME);
		state.lineHashB = (Math.imul(state.lineHashB, HASH_B_MULTIPLIER) + code) | 0;
	}
	const codePoint = entry.value.codePointAt(0) ?? 0;
	const lineWasEmpty = !state.lineHasContent;
	if (!isAsciiWhitespace(codePoint)) {
		state.lineHasContent = true;
		noteProgressEpoch(state, progressEpoch);
	}
	if (isAsciiAlphanumeric(codePoint) || (codePoint > 0x7f && !isBoxDrawing(codePoint))) state.lineWordChars += 1;
	state.lineLength += entry.width;
	if (state.lineText.length < PARAGRAPH_TEXT_RETENTION_MAX) state.lineText += entry.value;
	updateNormalizedLine(state, entry, lineWasEmpty);
	return null;
}
