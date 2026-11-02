import { encodeKeys } from "../terminal/shared.ts";
import { type EditorState, FRESH_EDITOR, type LineDraft, LineEditor } from "./line-editor.ts";

/** A background shell between `bash_input` calls: its line editor and the lines it has run. */
export interface TypedSession {
	readonly editor: EditorState;
	readonly history: readonly string[];
}

/** A line a `bash_input` call submits. */
export interface SubmittedLine {
	/** The line the shell runs, exact unless `alternatives` is non-empty. */
	readonly text: string;
	/** Other lines an edited line could be: the append-only text, every printable byte typed, each yank. */
	readonly alternatives: readonly string[];
	/** A key the guard cannot follow was used and the line could still spell a kill-family command. */
	readonly unfollowable: boolean;
}

export interface TypedLines {
	readonly lines: readonly SubmittedLine[];
	readonly session: TypedSession;
}

export const FRESH_SESSION: TypedSession = { editor: FRESH_EDITOR, history: [] };

const HISTORY_SIZE = 200;
const KILL_FAMILY = ["kill", "pkill", "killall"];

type Key = (editor: LineEditor) => void;

const CONTROL_KEYS: Record<string, Key> = {
	"\x01": (editor) => editor.moveTo(0),
	"\x02": (editor) => editor.moveBy(-1),
	"\x03": (editor) => editor.discard(),
	"\x04": (editor) => editor.deleteForward(),
	"\x05": (editor) => editor.moveTo(Number.MAX_SAFE_INTEGER),
	"\x06": (editor) => editor.moveBy(1),
	"\x08": (editor) => editor.backspace(),
	"\t": (editor) => editor.unfollowed(false, "\t"),
	"\x0b": (editor) => editor.killToEnd(),
	"\x0c": (editor) => editor.ignore(),
	"\x15": (editor) => editor.killToStart(),
	"\x17": (editor) => editor.killWordBackward(),
	"\x19": (editor) => editor.yank(),
	"\x7f": (editor) => editor.backspace(),
};

const ESCAPE_KEYS: Record<string, Key> = {
	"\x1b[H": (editor) => editor.moveTo(0),
	"\x1b[1~": (editor) => editor.moveTo(0),
	"\x1b[7~": (editor) => editor.moveTo(0),
	"\x1bOH": (editor) => editor.moveTo(0),
	"\x1b[F": (editor) => editor.moveTo(Number.MAX_SAFE_INTEGER),
	"\x1b[4~": (editor) => editor.moveTo(Number.MAX_SAFE_INTEGER),
	"\x1b[8~": (editor) => editor.moveTo(Number.MAX_SAFE_INTEGER),
	"\x1bOF": (editor) => editor.moveTo(Number.MAX_SAFE_INTEGER),
	"\x1b[D": (editor) => editor.moveBy(-1),
	"\x1bOD": (editor) => editor.moveBy(-1),
	"\x1b[C": (editor) => editor.moveBy(1),
	"\x1bOC": (editor) => editor.moveBy(1),
	"\x1b[3~": (editor) => editor.deleteForward(),
};

// History keys, meta keys, vi-mode commands and any other sequence: the line is no longer known and may be an
// earlier one.
const UNKNOWN_KEY: Key = (editor) => editor.unfollowed(true);

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

/** A word tab completion could finish as a kill-family name, or one that already is one (`k`, `pki`, `/bin/kill`). */
function hasKillFamilyWord(text: string): boolean {
	return text
		.split(/[\s;&|()<>`$"'{}=\\]+/)
		.map((word) => word.split("/").at(-1) ?? word)
		.some((word) => word !== "" && KILL_FAMILY.some((name) => name.startsWith(word) || word.startsWith(name)));
}

/** Enough letters to spell `kill` (every kill-family name contains it) in any order the cursor could put them. */
function spellsKill(text: string): boolean {
	const count = (letter: string) => text.split(letter).length - 1;
	return count("k") >= 1 && count("i") >= 1 && count("l") >= 2;
}

function submitted(line: LineDraft, editor: EditorState, history: readonly string[]): SubmittedLine {
	if (!line.edited) return { text: line.text, alternatives: [], unfollowable: false };
	const alternatives = [...new Set([line.appendOnly, line.typed, ...line.yanked])].filter(
		(text) => text !== line.text,
	);
	const candidates = [line.text, ...alternatives];
	// Tab completes the word at the cursor; an unknown key may also move the cursor, yank-pop or recall history.
	const unfollowable =
		line.unfollowed &&
		(candidates.some(hasKillFamilyWord) ||
			(line.recalled &&
				(spellsKill([...candidates, ...editor.killRing].join(" ")) || history.some(hasKillFamilyWord))));
	return { text: line.text, alternatives, unfollowable };
}

/** Feeds `stream` into a background shell's line editor the way it reads it, and returns the lines it submits. */
export function typeInto(session: TypedSession, stream: string): TypedLines {
	const editor = new LineEditor(session.editor);
	const history = [...session.history];
	const lines: SubmittedLine[] = [];
	let index = 0;
	while (index < stream.length) {
		const char = stream.charAt(index);
		if (char === "\r" || char === "\n") {
			const before = editor.state;
			const line = submitted(editor.submit(), before, history);
			lines.push(line);
			history.push(line.text);
			index += char === "\r" && stream.charAt(index + 1) === "\n" ? 2 : 1;
			continue;
		}
		if (char === "\x1b") {
			const length = escapeLength(stream, index);
			(ESCAPE_KEYS[stream.slice(index, index + length)] ?? UNKNOWN_KEY)(editor);
			index += length;
			continue;
		}
		const key = CONTROL_KEYS[char];
		if (key !== undefined) key(editor);
		else if (char >= " ") editor.insert(char);
		else UNKNOWN_KEY(editor);
		index += 1;
	}
	return { lines, session: { editor: editor.state, history: history.slice(-HISTORY_SIZE) } };
}
