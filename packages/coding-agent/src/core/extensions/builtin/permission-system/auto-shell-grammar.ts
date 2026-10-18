import type { ShellWord } from "./auto-shell-segments.ts";

/**
 * What a word means to the program, so the judge knows how to check it: `read-file` is read from
 * (must be a regular project file), `list` only has its name shown, `text` is never used as a path
 * (a pattern, a count, a format), and `ref-or-path` is a git revision unless something exists at
 * that name, in which case it is checked like `list` (git reads it as a path).
 */
export type WordRole = "read-file" | "list" | "text" | "ref-or-path";

export interface ClassifiedWord {
	readonly role: WordRole;
	readonly word: ShellWord;
}

export interface ProgramSpec {
	/** Every flag the program may take; `true` = no value, a role = takes one value. */
	readonly flags: Readonly<Record<string, true | WordRole>>;
	/** The role of operand `index` out of `count` operands, given its text. */
	readonly operand: (index: number, count: number, text: string) => WordRole;
	readonly minOperands?: number;
	readonly maxOperands?: number;
}

/**
 * Classifies every word of one simple command against `spec`, or returns undefined when any word
 * is not understood: an unknown flag (short or long), a flag in a form the spec does not list, a
 * value-taking flag with no value, or an operand count out of range. Short flags may be
 * clustered (`-la`), and a value-taking short flag takes the rest of its word as the value
 * (`-o/x`, `-ro/x`) or else the next word; a long flag takes `--name=value` or `--name value`.
 */
export function classifyWords(words: readonly ShellWord[], spec: ProgramSpec): ClassifiedWord[] | undefined {
	const classified: ClassifiedWord[] = [];
	const operands: ShellWord[] = [];
	let optionsEnded = false;
	for (let index = 0; index < words.length; index += 1) {
		const word = words[index];
		const text = word.text;
		if (optionsEnded || text === "-" || !text.startsWith("-")) {
			operands.push(word);
			continue;
		}
		if (text === "--") {
			optionsEnded = true;
			continue;
		}
		if (text.startsWith("--")) {
			const separator = text.indexOf("=");
			const name = separator < 0 ? text : text.slice(0, separator);
			const flag = spec.flags[name];
			if (flag === undefined) return undefined;
			if (flag === true) {
				if (separator >= 0) return undefined;
				continue;
			}
			if (separator >= 0) {
				classified.push({ role: flag, word: { text: text.slice(separator + 1) } });
				continue;
			}
			const value = words[index + 1];
			if (value === undefined) return undefined;
			classified.push({ role: flag, word: value });
			index += 1;
			continue;
		}
		for (let position = 1; position < text.length; position += 1) {
			const flag = spec.flags[`-${text[position]}`];
			if (flag === undefined) return undefined;
			if (flag === true) continue;
			const attached = text.slice(position + 1);
			if (attached !== "") {
				classified.push({ role: flag, word: { text: attached } });
			} else {
				const value = words[index + 1];
				if (value === undefined) return undefined;
				classified.push({ role: flag, word: value });
				index += 1;
			}
			break;
		}
	}
	if (operands.length < (spec.minOperands ?? 0)) return undefined;
	if (spec.maxOperands !== undefined && operands.length > spec.maxOperands) return undefined;
	operands.forEach((word, index) => {
		classified.push({ role: spec.operand(index, operands.length, word.text), word });
	});
	return classified;
}
