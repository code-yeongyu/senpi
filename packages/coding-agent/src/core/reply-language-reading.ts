/**
 * Reads what one user message says about the reply language (omo#11527): the language the user
 * writes their own words in, and any language they explicitly ask the agent to reply in. Only the
 * user's own prose counts; code, quoted lines, tagged blocks, links and pasted log or error lines
 * do not. Every scan is linear in the text length, since a message can be a large paste.
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

/** Languages a user can ask for by name, with their Korean names. */
const REQUESTABLE_LANGUAGES: Record<string, readonly string[]> = {
	English: ["영어"],
	Korean: ["한국어", "한글"],
	Japanese: ["일본어"],
	Chinese: ["중국어"],
	French: ["프랑스어", "불어"],
	German: ["독일어"],
	Spanish: ["스페인어"],
	Russian: ["러시아어"],
	Portuguese: ["포르투갈어"],
	Italian: ["이탈리아어"],
	Vietnamese: ["베트남어"],
	Thai: ["태국어"],
};

/** Every language name a note can carry; a note never carries any other text. */
export const REPLY_LANGUAGE_NAMES: readonly string[] = [
	...new Set([...Object.values(LANGUAGE_OF_SCRIPT), "Chinese", ...Object.keys(REQUESTABLE_LANGUAGES)]),
];

const KOREAN_NAME_TO_LANGUAGE = new Map(
	Object.entries(REQUESTABLE_LANGUAGES).flatMap(([language, names]) => names.map((name) => [name, language] as const)),
);
const KOREAN_NAMES = [...KOREAN_NAME_TO_LANGUAGE.keys()].join("|");
/** "영어로 답해줘" (the language, then a reply verb) and "답변은 영어로 해줘" (the reply, then the language). */
const KOREAN_REQUESTS: readonly RegExp[] = [
	new RegExp(`(${KOREAN_NAMES})\\s*로\\s*(?:만\\s*|좀\\s*)?(?:답|대답|응답|말|얘기|이야기|소통|보고)`, "g"),
	new RegExp(
		`(?:답변|대답|응답|답장)\\s*(?:은|는|을|도)?\\s*(?:앞으로\\s*|이제\\s*|전부\\s*|모두\\s*)?(${KOREAN_NAMES})\\s*로`,
		"g",
	),
];
const KOREAN_NEGATION_AFTER = /^[가-힣\s]{0,6}?지\s*(?:마|말)/;
const ENGLISH_NAMES = Object.keys(REQUESTABLE_LANGUAGES).join("|");
const ENGLISH_REQUEST = new RegExp(
	`\\b(?:(?:reply|respond|answer|talk|speak|communicate|chat)(?:\\s+[a-z]+){0,3}?\\s+in\\s+(${ENGLISH_NAMES})|(?:use|in)\\s+(${ENGLISH_NAMES})\\s+(?:from now on|for (?:your |all )?(?:replies|responses|answers)))\\b`,
	"gi",
);
const ENGLISH_NEGATION_BEFORE = /\b(?:not|never|don't|dont|n't)\s*$/i;

/** A script that is at least this share of the words decides the language. */
const SCRIPT_SHARE = 0.3;

/** Characters per word for scripts written without spaces (Chinese, Japanese, Thai). */
const UNSPACED_CHARS_PER_WORD = 2;

/** A line that reads as pasted log or error output, not as words the user wrote to the agent. */
const LOG_LINE =
	/^\s*(?:at\s|\[|\d{4}-\d{2}-\d{2}|[\w$.]*(?:Error|Exception)\b|(?:error|warning|fatal|panic|traceback|오류|에러|경고)\s*[:[(]|[\w./\\-]+:\d+)/i;

function isTagNameChar(char: string): boolean {
	return /[\w-]/.test(char);
}

/**
 * Drops `<name ...>...</name>` blocks (injected `<environment_context>`, reminders) in one pass.
 * Closing-tag positions are collected first and each tag name's cursor only moves forward, so an
 * unclosed `<` (TypeScript generics, comparisons) costs one scan to the next `<`, never a rescan.
 */
function withoutTaggedBlocks(text: string): string {
	const closings = new Map<string, number[]>();
	for (const match of text.matchAll(/<\/([A-Za-z][\w-]*)>/g)) {
		const name = match[1] ?? "";
		const positions = closings.get(name) ?? [];
		positions.push(match.index);
		closings.set(name, positions);
	}
	if (closings.size === 0) return text;
	const cursors = new Map<string, number>();
	let output = "";
	let copiedUntil = 0;
	let index = text.indexOf("<");
	while (index >= 0) {
		let nameEnd = index + 1;
		while (nameEnd < text.length && isTagNameChar(text[nameEnd] ?? "")) nameEnd++;
		const name = text.slice(index + 1, nameEnd);
		let tagEnd = nameEnd;
		while (tagEnd < text.length && !"<>\n".includes(text[tagEnd] ?? "")) tagEnd++;
		const positions = /^[A-Za-z]/.test(name) && text[tagEnd] === ">" ? closings.get(name) : undefined;
		if (positions) {
			let cursor = cursors.get(name) ?? 0;
			while (cursor < positions.length && (positions[cursor] ?? 0) <= tagEnd) cursor++;
			cursors.set(name, cursor);
			const closing = positions[cursor];
			if (closing !== undefined) {
				output += `${text.slice(copiedUntil, index)} `;
				copiedUntil = closing + name.length + 3;
				index = text.indexOf("<", copiedUntil);
				continue;
			}
		}
		index = text.indexOf("<", Math.max(tagEnd, index + 1));
	}
	return output + text.slice(copiedUntil);
}

/** The lines the user wrote to the agent: no code, tagged blocks, links, quoted or log lines. */
function ownLines(text: string): string[] {
	const prose = withoutTaggedBlocks(text)
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`\n]*`/g, " ")
		.replace(/\bhttps?:\/\/\S+/g, " ");
	return prose.split("\n").filter((line) => line.trim() !== "" && !/^\s*>/.test(line) && !LOG_LINE.test(line));
}

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

/** The reply language the user explicitly asks for in this message (the last request wins). */
export function readReplyLanguageRequest(text: string): string | undefined {
	const prose = ownLines(text).join("\n");
	const requests: { readonly index: number; readonly language: string | undefined }[] = [];
	for (const match of KOREAN_REQUESTS.flatMap((pattern) => [...prose.matchAll(pattern)])) {
		if (KOREAN_NEGATION_AFTER.test(prose.slice(match.index + match[0].length))) continue;
		requests.push({ index: match.index, language: KOREAN_NAME_TO_LANGUAGE.get(match[1] ?? "") });
	}
	for (const match of prose.matchAll(ENGLISH_REQUEST)) {
		if (ENGLISH_NEGATION_BEFORE.test(prose.slice(Math.max(0, match.index - 12), match.index))) continue;
		const name = (match[1] ?? match[2] ?? "").toLowerCase();
		const language = Object.keys(REQUESTABLE_LANGUAGES).find((candidate) => candidate.toLowerCase() === name);
		requests.push({ index: match.index, language });
	}
	return requests
		.sort((left, right) => left.index - right.index)
		.filter((request) => request.language !== undefined)
		.at(-1)?.language;
}
