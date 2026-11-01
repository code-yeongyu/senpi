import { encodeKeys } from "../terminal/shared.ts";

/** What a `bash_input` call hands the shell's line editor: the lines it submits and the text left on the line. */
export interface TypedLines {
	/** Every line the call completes, in order (a line break in the text, `submit`, or an `enter` key). */
	readonly lines: readonly string[];
	/** The unsubmitted text on the current line afterwards; the next call's Enter submits it. */
	readonly pending: string;
}

const LINE_ENDS = new Set(["\r", "\n"]);
// SIGINT and kill-line make the line editor drop the current line.
const LINE_DISCARDS = new Set(["\x03", "\x15"]);
const ERASES = new Set(["\x7f", "\b"]);

/** Bytes in the escape sequence at `start`: CSI (`ESC [` params, final byte 0x40-0x7e), SS3 (`ESC O x`), or `ESC x`. */
function escapeLength(stream: string, start: number): number {
	const kind = stream.charAt(start + 1);
	if (kind !== "[") return Math.min(kind === "O" ? 3 : 2, stream.length - start);
	let end = start + 2;
	while (end < stream.length && stream.charCodeAt(end) < 0x40) end += 1;
	return Math.min(end + 1, stream.length) - start;
}

/** The bytes a `bash_input` call writes, in the tool's order: the text, Enter when submitted, then the named keys. */
export function bashInputStream(input: Record<string, unknown>): string {
	const text = typeof input.input === "string" ? input.input : undefined;
	const submit = typeof input.submit === "boolean" ? input.submit : (text?.length ?? 0) > 0;
	const keys = Array.isArray(input.keys) ? input.keys.filter((key): key is string => typeof key === "string") : [];
	const typed = text === undefined ? "" : submit ? `${text}\r` : text;
	return `${typed}${encodeKeys(keys).data}`;
}

/** Feeds `stream` into a line that already holds `pending`, the way a terminal line editor reads it. */
export function typeInto(pending: string, stream: string): TypedLines {
	const lines: string[] = [];
	let line = pending;
	let index = 0;
	while (index < stream.length) {
		const char = stream.charAt(index);
		if (LINE_ENDS.has(char)) {
			lines.push(line);
			line = "";
			index += char === "\r" && stream.charAt(index + 1) === "\n" ? 2 : 1;
			continue;
		}
		if (char === "\x1b") {
			// Cursor and function keys move the cursor or recall history; they type no text.
			index += escapeLength(stream, index);
			continue;
		}
		if (LINE_DISCARDS.has(char)) line = "";
		else if (ERASES.has(char)) line = line.slice(0, -1);
		else if (char >= " " || char === "\t") line += char;
		index += 1;
	}
	return { lines, pending: line };
}
