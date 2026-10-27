/**
 * The parts of a user message the user wrote to the agent themselves (omo#11527). Every pass is
 * linear in the text length, since a message can be a large paste; `ProseScan` counts the
 * characters the tag pass visits so a test can bound it without timing.
 */

export interface ProseScan {
	steps: number;
}

/** A line that reads as pasted log or error output, not as words the user wrote to the agent. */
const LOG_LINE =
	/^\s*(?:at\s|\[|\d{4}-\d{2}-\d{2}|[\w$.]*(?:Error|Exception)\b|(?:error|warning|fatal|panic|traceback|오류|에러|경고)\s*[:[(]|[\w./\\-]+:\d+)/i;

/** Quoted spans of any style; the length bound keeps an unpaired opening mark linear. */
const QUOTED_SPAN =
	/"[^"\n]{0,400}"|“[^”\n]{0,400}”|‘[^’\n]{0,400}’|「[^」\n]{0,400}」|『[^』\n]{0,400}』|«[^»\n]{0,400}»/g;

/** Any quotation mark, including a single quote: a request near one is never taken as the user's own. */
export const QUOTE_MARK = /["'“”‘’「」『』«»`]/;

function isTagNameChar(char: string): boolean {
	return /[\w-]/.test(char);
}

/**
 * Drops `<name ...>...</name>` blocks (injected `<environment_context>`, reminders) in one pass.
 * Closing-tag positions are collected first and each tag name's cursor only moves forward, so an
 * unclosed `<` (TypeScript generics, comparisons) costs one scan to the next `<`, never a rescan.
 */
export function withoutTaggedBlocks(text: string, scan: ProseScan = { steps: 0 }): string {
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
		scan.steps += tagEnd - index + 1;
		const positions = /^[A-Za-z]/.test(name) && text[tagEnd] === ">" ? closings.get(name) : undefined;
		if (positions) {
			let cursor = cursors.get(name) ?? 0;
			while (cursor < positions.length && (positions[cursor] ?? 0) <= tagEnd) {
				cursor++;
				scan.steps++;
			}
			cursors.set(name, cursor);
			const closing = positions[cursor];
			if (closing !== undefined) {
				output += `${text.slice(copiedUntil, index)} `;
				copiedUntil = closing + name.length + 3;
				const next = text.indexOf("<", copiedUntil);
				scan.steps += (next < 0 ? text.length : next) - copiedUntil;
				index = next;
				continue;
			}
		}
		const from = Math.max(tagEnd, index + 1);
		const next = text.indexOf("<", from);
		scan.steps += (next < 0 ? text.length : next) - from;
		index = next;
	}
	return output + text.slice(copiedUntil);
}

/** Drops fenced code: every second ``` segment; an unclosed fence keeps its text, like before. */
function withoutFencedCode(text: string): string {
	const segments = text.split("```");
	if (segments.length % 2 === 0) segments.splice(-2, 2, `${segments.at(-2) ?? ""}${segments.at(-1) ?? ""}`);
	return segments.filter((_, index) => index % 2 === 0).join(" ");
}

/** The message with tagged blocks, fenced and inline code, and links removed. */
function userProse(text: string, scan?: ProseScan): string {
	return withoutFencedCode(withoutTaggedBlocks(text, scan))
		.replace(/`[^`\n]*`/g, " ")
		.replace(/\bhttps?:\/\/\S+/g, " ");
}

/** A line that is not the user's own words: a `>` quote or pasted log or error output. */
function isPastedLine(line: string): boolean {
	return /^\s*>/.test(line) || LOG_LINE.test(line);
}

/** The user's own lines, with quoted spans removed: reported speech is not the user's language. */
export function ownLines(text: string, scan?: ProseScan): string[] {
	return userProse(text, scan)
		.split("\n")
		.map((line) => line.replace(QUOTED_SPAN, " "))
		.filter((line) => line.trim() !== "" && !isPastedLine(line));
}
