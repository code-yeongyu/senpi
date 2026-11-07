import { ownLines } from "./user-prose.ts";

/**
 * The language a user message is written in (omo#11527), read from the user's own lines only
 * (`ownLines`): code, tagged blocks, links, quoted spans and lines, and pasted log or error lines
 * do not count.
 */

export type ReplyLanguageReading = { kind: "none" } | { kind: "latin" } | { kind: "language"; language: string };

type ScriptName = "hangul" | "kana" | "han" | "thai" | "greek" | "hebrew" | "cyrillic" | "arabic" | "devanagari";

const SCRIPTS: readonly { readonly name: ScriptName; readonly pattern: RegExp; readonly spaced: boolean }[] = [
	{ name: "hangul", pattern: /\p{Script=Hangul}/gu, spaced: true },
	{ name: "kana", pattern: /[\p{Script=Hiragana}\p{Script=Katakana}]/gu, spaced: false },
	{ name: "han", pattern: /\p{Script=Han}/gu, spaced: false },
	{ name: "thai", pattern: /\p{Script=Thai}/gu, spaced: false },
	{ name: "greek", pattern: /\p{Script=Greek}/gu, spaced: true },
	{ name: "hebrew", pattern: /\p{Script=Hebrew}/gu, spaced: true },
	{ name: "cyrillic", pattern: /\p{Script=Cyrillic}/gu, spaced: true },
	{ name: "arabic", pattern: /\p{Script=Arabic}/gu, spaced: true },
	{ name: "devanagari", pattern: /\p{Script=Devanagari}/gu, spaced: true },
];

/** A script shared by several languages is named by its script, never by a guessed language. */
const LANGUAGE_OF_SCRIPT: Record<Exclude<ScriptName, "han">, string> = {
	hangul: "Korean",
	kana: "Japanese",
	thai: "Thai",
	greek: "Greek",
	hebrew: "Hebrew",
	cyrillic: "Cyrillic script",
	arabic: "Arabic script",
	devanagari: "Devanagari script",
};

export const SCRIPT_LANGUAGE_NAMES: readonly string[] = [...Object.values(LANGUAGE_OF_SCRIPT), "Chinese"];

/** A script that is at least this share of the words decides the language. */
const SCRIPT_SHARE = 0.3;

/** Characters per word for scripts written without spaces (Chinese, Japanese, Thai). */
const UNSPACED_CHARS_PER_WORD = 2;

function lettered(words: readonly string[]): number {
	return words.filter((word) => /\p{L}/u.test(word)).length;
}

function readWords(text: string): ReplyLanguageReading {
	const weights = new Map<ScriptName, number>();
	let latinWords = 0;
	for (const word of text.split(/\s+/)) {
		const script = SCRIPTS.find((candidate) => candidate.pattern.test(word));
		for (const candidate of SCRIPTS) candidate.pattern.lastIndex = 0;
		if (script) {
			const count = word.match(script.pattern)?.length ?? 0;
			weights.set(
				script.name,
				(weights.get(script.name) ?? 0) + (script.spaced ? 1 : count / UNSPACED_CHARS_PER_WORD),
			);
		} else if (/\p{Script=Latin}/u.test(word)) latinWords++;
	}
	// Japanese mixes kana with Han characters; Han without kana is Chinese.
	const kana = weights.get("kana") ?? 0;
	if (kana > 0) {
		weights.set("kana", kana + (weights.get("han") ?? 0));
		weights.delete("han");
	}
	let best: { name: ScriptName; weight: number } | undefined;
	let total = latinWords;
	for (const [name, weight] of weights) {
		total += weight;
		if (!best || weight > best.weight) best = { name, weight };
	}
	if (total === 0) return { kind: "none" };
	if (!best || best.weight < total * SCRIPT_SHARE) return { kind: "latin" };
	return { kind: "language", language: best.name === "han" ? "Chinese" : LANGUAGE_OF_SCRIPT[best.name] };
}

/**
 * The language of the user's own words. The first line with at least two words decides, since a
 * pasted block usually follows the user's request; without such a line, all of the prose decides.
 */
export function readReplyLanguage(text: string): ReplyLanguageReading {
	const lines = ownLines(text);
	const first = lines.find((line) => lettered(line.split(/\s+/)) >= 2);
	return readWords(first ?? lines.join(" "));
}
