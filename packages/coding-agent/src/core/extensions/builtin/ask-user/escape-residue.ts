import type { Question } from "./schema.ts";

/**
 * Escape residue in question text (oh-my-openagent#12797). Some models write non-ASCII tool-call text as
 * `\uXXXX` escapes and then drop the backslash (`ub0b4 Tailscale 쓰기` for `내 Tailscale 쓰기`) or double it, so
 * the decoded string still holds `\ub0b4`. The JSON is valid either way; only the text is wrong.
 *
 * Heuristic, applied to every header, question, option label and option description after inline code
 * spans (`...`) are blanked out, since quoted code may name an escape on purpose:
 * - A literal `\uXXXX` whose code point is non-ASCII is residue.
 * - A bare run of `uXXXX` tokens is a candidate only when no ASCII letter, digit, `_` or `\` precedes it and
 *   none follows it, so `menu1234`, `u1a2b3c4d` and other hex-like ids never match. A candidate is residue
 *   when it decodes to non-ASCII text and either
 *   - the run has two or more tokens (`ub0b4uc4f0`), each decoding to a letter, mark, number, punctuation or
 *     symbol (a paired surrogate counts), or
 *   - its single token decodes to a letter in a script the question set already uses outside ASCII, with
 *     Hangul, Han, Hiragana, Katakana and Bopomofo counted as one family (a wrong high digit lands a Hangul
 *     syllable in Han). `u1234` in English text, or beside Korean text, decodes to Ethiopic and stays.
 * Known gap: a token glued to a preceding ASCII letter (`cafu00e9`) is not detected.
 */
export type EscapeResidue = { field: string; token: string };

const BARE_RUN = /(?<![\\A-Za-z0-9_])((?:u[0-9a-fA-F]{4})+)(?![A-Za-z0-9_])/g;
const LITERAL = /\\u([0-9a-fA-F]{4})/g;
const CODE_SPAN = /`[^`\n]*`/g;
const NON_ASCII_LETTER = /(?!\p{ASCII})\p{L}/gu;
const PRINTABLE = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;
const CJK_FAMILY = "CJK";
const SCRIPTS: Array<[string, RegExp]> = [
	[CJK_FAMILY, /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}]/u],
	["Latin", /\p{Script=Latin}/u],
	["Cyrillic", /\p{Script=Cyrillic}/u],
	["Greek", /\p{Script=Greek}/u],
	["Arabic", /\p{Script=Arabic}/u],
	["Hebrew", /\p{Script=Hebrew}/u],
	["Thai", /\p{Script=Thai}/u],
	["Devanagari", /\p{Script=Devanagari}/u],
];

function scriptOf(char: string): string | undefined {
	return SCRIPTS.find(([, pattern]) => pattern.test(char))?.[0];
}

function decode(run: string): string {
	const units: number[] = [];
	for (let index = 1; index < run.length; index += 5) units.push(Number.parseInt(run.slice(index, index + 4), 16));
	return String.fromCharCode(...units);
}

function isResidueRun(run: string, scripts: Set<string>): boolean {
	const decoded = decode(run);
	const chars = Array.from(decoded);
	if (chars.some((char) => (char.codePointAt(0) ?? 0) < 0x80)) return false;
	if (run.length > 5) return chars.every((char) => PRINTABLE.test(char));
	const char = chars[0] ?? "";
	if (!/\p{L}/u.test(char)) return false;
	const script = scriptOf(char);
	return script !== undefined && scripts.has(script);
}

function textFields(questions: readonly Question[]): Array<[string, string]> {
	const fields: Array<[string, string]> = [];
	questions.forEach((question, index) => {
		const at = `questions[${index}]`;
		fields.push([`${at}.header`, question.header], [`${at}.question`, question.question]);
		question.options.forEach((option, optionIndex) => {
			fields.push([`${at}.options[${optionIndex}].label`, option.label]);
			if (option.description !== undefined)
				fields.push([`${at}.options[${optionIndex}].description`, option.description]);
		});
	});
	return fields;
}

export function findEscapeResidue(questions: readonly Question[]): EscapeResidue[] {
	const fields = textFields(questions).map(([field, text]): [string, string] => [
		field,
		text.replace(CODE_SPAN, (span) => " ".repeat(span.length)),
	]);
	const scripts = new Set<string>();
	for (const [, text] of fields) {
		for (const [char] of text.matchAll(NON_ASCII_LETTER)) {
			const script = scriptOf(char);
			if (script !== undefined) scripts.add(script);
		}
	}
	const residue: EscapeResidue[] = [];
	for (const [field, text] of fields) {
		for (const match of text.matchAll(LITERAL)) {
			if (Number.parseInt(match[1] ?? "0", 16) >= 0x80) residue.push({ field, token: match[0] });
		}
		for (const match of text.matchAll(BARE_RUN)) {
			const run = match[1] ?? "";
			if (isResidueRun(run, scripts)) residue.push({ field, token: run });
		}
	}
	return residue;
}

export class AskUserEscapeResidueError extends Error {
	readonly residue: EscapeResidue[];
	constructor(residue: EscapeResidue[]) {
		const found = residue.map(({ field, token }) => `${field} has "${token}"`).join("; ");
		super(
			`Escape residue in the question text: ${found}. Non-ASCII text was written as a \\uXXXX escape that lost its backslash or kept a literal one, so the user would see the code instead of the character. Call this tool again with the same questions, writing every non-ASCII character directly as UTF-8 text, never as a \\uXXXX escape.`,
		);
		this.name = "AskUserEscapeResidueError";
		this.residue = residue;
	}
}

export function escapeResidueNote(residue: readonly EscapeResidue[]): string {
	const tokens = [...new Set(residue.map(({ token }) => token))].join(", ");
	return `This question may show undecoded character codes (${tokens}); it is shown as the model wrote it.`;
}
