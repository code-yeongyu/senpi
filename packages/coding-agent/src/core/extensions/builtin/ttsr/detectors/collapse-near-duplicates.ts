import { CharCode, FixedRing, isAsciiWhitespace, type ScalarEntry } from "../stream-utils.ts";
import type { DetectorMatch } from "../types.ts";
import { isAsciiAlphanumeric, isBoxDrawing } from "./collapse-scalars.ts";
import { normalizeTurnText } from "./repetitive-turns.ts";

export const NEAR_DUPLICATE_MIN_CHARS = 64;
export const NEAR_DUPLICATE_MIN_WORD_CHARS = 24;
export const NEAR_DUPLICATE_SIMILARITY = 0.5;
export const NEAR_DUPLICATE_LOOKBACK = 32;
export const NEAR_DUPLICATE_WINDOW = 12;
export const NEAR_DUPLICATE_ECHO_THRESHOLD = 8;
export const NEAR_DUPLICATE_TEXT_RETENTION_MAX = 512;

const SAMPLE_LENGTH = 80;
const WORD_PATTERN = /[\p{L}\p{N}#]+/gu;
const FENCE_PATTERN = /^(?:```|~~~)/;
// An indented line that is not a nested list item (two spaces or a tab, then not `- `, `* `, `+ `, `1. `, `1) `).
const INDENTED_CODE = /^(?: {2,}|\t)(?![ \t]*(?:[-*+]|\d+[.)])[ \t])/;
// A line ending in a block, statement or markup delimiter: `{`, `}`, `[`, `]`, `(`, `;`, `,`, `>` (oh-my-pi's set).
const CODE_LINE_ENDINGS = new Set(["{", "}", "[", "]", "(", ";", ",", ">"]);

interface ParagraphSignature {
	readonly tokens: ReadonlySet<string>;
	readonly startOffset: number;
	readonly sample: string;
}

interface WindowEntry {
	readonly echoed: boolean;
	readonly startOffset: number;
	readonly anchorStartOffset: number;
}

export interface NearDuplicateState {
	readonly history: FixedRing<ParagraphSignature>;
	readonly window: FixedRing<WindowEntry>;
	lineLength: number;
	lineWordChars: number;
	lineHasContent: boolean;
	lineStartOffset: number;
	lineText: string;
	lineLastChar: string;
	length: number;
	wordChars: number;
	startOffset: number;
	retained: string;
	fenced: boolean;
	insideFence: boolean;
}

export function createNearDuplicateState(): NearDuplicateState {
	return {
		history: new FixedRing<ParagraphSignature>(NEAR_DUPLICATE_LOOKBACK),
		window: new FixedRing<WindowEntry>(NEAR_DUPLICATE_WINDOW),
		lineLength: 0,
		lineWordChars: 0,
		lineHasContent: false,
		lineStartOffset: 0,
		lineText: "",
		lineLastChar: "",
		length: 0,
		wordChars: 0,
		startOffset: 0,
		retained: "",
		fenced: false,
		insideFence: false,
	};
}

function tokenize(text: string): ReadonlySet<string> {
	return new Set(normalizeTurnText(text).match(WORD_PATTERN) ?? []);
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const token of a) {
		if (b.has(token)) intersection += 1;
	}
	return intersection / (a.size + b.size - intersection);
}

function resetParagraph(state: NearDuplicateState): void {
	state.length = 0;
	state.wordChars = 0;
	state.startOffset = 0;
	state.retained = "";
	state.fenced = false;
}

function countEchoes(state: NearDuplicateState): number {
	let echoes = 0;
	for (let back = state.window.size - 1; back >= 0; back--) {
		if (state.window.getBack(back)?.echoed === true) echoes += 1;
	}
	return echoes;
}

function oldestEcho(state: NearDuplicateState): WindowEntry | undefined {
	for (let back = state.window.size - 1; back >= 0; back--) {
		const entry = state.window.getBack(back);
		if (entry?.echoed === true) return entry;
	}
	return undefined;
}

function completeParagraph(state: NearDuplicateState): DetectorMatch | null {
	const eligible =
		!state.fenced && state.length >= NEAR_DUPLICATE_MIN_CHARS && state.wordChars >= NEAR_DUPLICATE_MIN_WORD_CHARS;
	const text = state.retained;
	const startOffset = state.startOffset;
	resetParagraph(state);
	if (!eligible) return null;
	const tokens = tokenize(text);
	if (tokens.size === 0) return null;
	let best = 0;
	let anchor: ParagraphSignature | undefined;
	for (let back = 0; back < state.history.size; back++) {
		const previous = state.history.getBack(back);
		if (previous === undefined) continue;
		const similarity = jaccard(tokens, previous.tokens);
		if (similarity > best) {
			best = similarity;
			anchor = previous;
		}
	}
	const echoed = best >= NEAR_DUPLICATE_SIMILARITY && anchor !== undefined;
	state.history.push({ tokens, startOffset, sample: text.slice(0, SAMPLE_LENGTH) });
	state.window.push({
		echoed,
		startOffset,
		anchorStartOffset: echoed && anchor !== undefined ? anchor.startOffset : startOffset,
	});
	const echoes = countEchoes(state);
	if (echoes < NEAR_DUPLICATE_ECHO_THRESHOLD) return null;
	const first = oldestEcho(state);
	if (first === undefined) return null;
	return {
		rule: "collapse-repetition",
		reason: `${echoes} of the last ${state.window.size} paragraphs restate an earlier paragraph of the same message`,
		anomalyStartOffset: first.anchorStartOffset,
		garbageStartOffset: first.startOffset,
		detail: {
			mechanism: "near-duplicate-paragraphs",
			echoes,
			window: state.window.size,
			similarity: Number(best.toFixed(3)),
			sample: anchor?.sample ?? "",
		},
	};
}

/**
 * Code and markup repeat one skeleton with different literals, so a run of same-shaped lines (SVG elements, JSON
 * objects) is not a narration loop. Lines shaped like code are left out of the paragraph, fenced or not, and a
 * paragraph made only of them is never scored (senpi#2865; oh-my-pi v18.8.0 drops the same line shapes before its loop heuristics).
 */
function isCodeShapedLine(state: NearDuplicateState): boolean {
	return INDENTED_CODE.test(state.lineText) || CODE_LINE_ENDINGS.has(state.lineLastChar);
}

function foldLine(state: NearDuplicateState): void {
	const fence = FENCE_PATTERN.test(state.lineText.trimStart());
	if (state.insideFence || fence) state.fenced = true;
	if (fence) state.insideFence = !state.insideFence;
	if (!state.fenced && isCodeShapedLine(state)) return;
	if (state.length === 0) state.startOffset = state.lineStartOffset;
	state.length += state.lineLength + 1;
	state.wordChars += state.lineWordChars;
	if (state.retained.length < NEAR_DUPLICATE_TEXT_RETENTION_MAX) state.retained += `${state.lineText}\n`;
}

function resetLine(state: NearDuplicateState, startOffset: number): void {
	state.lineLength = 0;
	state.lineWordChars = 0;
	state.lineHasContent = false;
	state.lineStartOffset = startOffset;
	state.lineText = "";
	state.lineLastChar = "";
}

export function updateNearDuplicates(state: NearDuplicateState, entry: ScalarEntry): DetectorMatch | null {
	if (entry.value.charCodeAt(0) === CharCode.LineFeed) {
		let result: DetectorMatch | null = null;
		if (state.lineHasContent) foldLine(state);
		else if (state.length > 0) result = completeParagraph(state);
		resetLine(state, entry.startOffset + 1);
		return result;
	}
	const codePoint = entry.value.codePointAt(0) ?? 0;
	if (!isAsciiWhitespace(codePoint)) {
		state.lineHasContent = true;
		state.lineLastChar = entry.value;
	}
	if (isAsciiAlphanumeric(codePoint) || (codePoint > 0x7f && !isBoxDrawing(codePoint))) state.lineWordChars += 1;
	state.lineLength += entry.width;
	if (state.lineText.length < NEAR_DUPLICATE_TEXT_RETENTION_MAX) state.lineText += entry.value;
	return null;
}
