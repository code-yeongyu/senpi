import type { DetectorMatch } from "../types.ts";

export const REPETITIVE_TURNS_RULE_NAME = "repetitive-turns";

export const REPETITIVE_TURNS_SIMILARITY_THRESHOLD = 0.55;
export const REPETITIVE_TURNS_STREAK_LENGTH = 3;
export const REPETITIVE_TURNS_MIN_NORMALIZED_CHARS = 40;
export const REPETITIVE_TURNS_HISTORY_CAPACITY = 6;

const WORD_PATTERN = /[\p{L}\p{N}#]+/gu;
const DIGIT_RUN_PATTERN = /\d[\d.,:/-]*/g;
const HEX_LIKE_PATTERN = /\b[0-9a-f]{7,}\b/gi;
const SAMPLE_LENGTH = 80;
// The handoff contract restates the user's request verbatim after `Ask:` in every block, so that clause is
// identical by design across turns; it ends where the block's own status starts (`For you:` / `You need:` / `Now:`).
// Only a clause that such a label closes is a handoff Ask; any other `Ask:` stays in the text, so a looping turn
// that merely contains the word keeps its full repetition signal (senpi#2143).
const HANDOFF_ASK_CLAUSE = /\bAsk:[\s\S]*?(?=\b(?:For you|You need|Now):)/g;

export function normalizeTurnText(text: string): string {
	return text
		.replace(HANDOFF_ASK_CLAUSE, " ")
		.toLowerCase()
		.replace(HEX_LIKE_PATTERN, "#")
		.replace(DIGIT_RUN_PATTERN, "#")
		.split(/\s+/)
		.filter((token) => token.length > 0)
		.join(" ")
		.trim();
}

function wordTrigrams(normalized: string): Set<string> {
	const words = normalized.match(WORD_PATTERN) ?? [];
	const grams = new Set<string>();
	for (let i = 0; i + 3 <= words.length; i++) {
		grams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
	}
	return grams;
}

export function trigramJaccard(a: string, b: string): number {
	const gramsA = wordTrigrams(a);
	const gramsB = wordTrigrams(b);
	if (gramsA.size === 0 || gramsB.size === 0) return 0;
	let intersection = 0;
	for (const gram of gramsA) {
		if (gramsB.has(gram)) intersection += 1;
	}
	return intersection / (gramsA.size + gramsB.size - intersection);
}

export function isNearDuplicateOfPreviousTurn(normalizedCandidate: string, normalizedPrevious: string): boolean {
	return trigramJaccard(normalizedCandidate, normalizedPrevious) >= REPETITIVE_TURNS_SIMILARITY_THRESHOLD;
}

interface TurnEntry {
	readonly normalized: string;
	readonly grams: Set<string>;
}

export interface RepetitiveTurnsState {
	readonly history: TurnEntry[];
	streak: number;
	latched: boolean;
}

export function createRepetitiveTurnsState(): RepetitiveTurnsState {
	return { history: [], streak: 0, latched: false };
}

function jaccardSets(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const gram of a) {
		if (b.has(gram)) intersection += 1;
	}
	return intersection / (a.size + b.size - intersection);
}

export function recordTurnText(state: RepetitiveTurnsState, text: string): DetectorMatch | null {
	const normalized = normalizeTurnText(text);
	if (normalized.length < REPETITIVE_TURNS_MIN_NORMALIZED_CHARS) {
		return null;
	}
	const grams = wordTrigrams(normalized);
	const previous = state.history[state.history.length - 1];
	const similarity = previous === undefined ? 0 : jaccardSets(grams, previous.grams);
	state.history.push({ normalized, grams });
	if (state.history.length > REPETITIVE_TURNS_HISTORY_CAPACITY) {
		state.history.shift();
	}
	if (similarity >= REPETITIVE_TURNS_SIMILARITY_THRESHOLD) {
		state.streak += 1;
	} else {
		state.streak = 0;
		if (state.latched) state.latched = false;
	}
	if (state.latched || state.streak < REPETITIVE_TURNS_STREAK_LENGTH - 1) {
		return null;
	}
	state.latched = true;
	return {
		rule: REPETITIVE_TURNS_RULE_NAME,
		reason: `assistant repeated a near-identical message across ${state.streak + 1} consecutive turns (jaccard ${similarity.toFixed(2)})`,
		anomalyStartOffset: 0,
		garbageStartOffset: 0,
		detail: {
			mechanism: "cross-turn",
			streak: state.streak + 1,
			similarity: Number(similarity.toFixed(3)),
			sample: normalized.slice(0, SAMPLE_LENGTH),
		},
	};
}
