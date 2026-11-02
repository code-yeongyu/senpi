import { encodeKeys } from "../terminal/shared.ts";
import { type EditorState, FRESH_EDITOR, type LineDraft, LineEditor } from "./line-editor.ts";

/** A background shell between `bash_input` calls: its line editor, the line being sent and the lines it has run. */
export interface TypedSession {
	readonly editor: EditorState;
	readonly pending: PendingLine;
	readonly history: readonly string[];
}

/** What the guard keeps of the line being sent besides the editor's model of it, carried across calls. */
interface PendingLine {
	/** Every byte >= 0x20 except DEL sent since the last submit, in order: kept when deleted, killed or in an escape. */
	readonly printable: string;
	/** Only printable bytes and backspace were sent, and no named key other than enter/return. */
	readonly plain: boolean;
	/** A tab followed a token that tab completion could finish as a kill-family name. */
	readonly tabbedKillPrefix: boolean;
	/** Lines that ended with an unescaped backslash, joined, waiting for the line that completes them. */
	readonly continued: SubmittedLine | undefined;
}

/** The bytes a `bash_input` call writes and which of them a named key wrote. */
export interface InputBytes {
	readonly stream: string;
	/** Offsets in `stream` written by a named key other than enter/return. */
	readonly keyed: ReadonlySet<number>;
}

/** A line a `bash_input` call submits. */
export interface SubmittedLine {
	/** The line the shell runs, exact unless `alternatives` is non-empty. */
	readonly text: string;
	/** Other lines an edited line could be: the append-only text, every printable byte typed, each yank. */
	readonly alternatives: readonly string[];
	/** The line was not typed plainly and could spell a kill-family command (see {@link couldSpellKill}). */
	readonly unfollowable: boolean;
}

export interface TypedLines {
	readonly lines: readonly SubmittedLine[];
	readonly session: TypedSession;
}

const FRESH_PENDING: PendingLine = { printable: "", plain: true, tabbedKillPrefix: false, continued: undefined };

export const FRESH_SESSION: TypedSession = { editor: FRESH_EDITOR, pending: FRESH_PENDING, history: [] };

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

const isSubmit = (char: string) => char === "\r" || char === "\n";

/**
 * Bytes in the escape sequence at `start`: CSI (`ESC [` params, final byte 0x40-0x7e), SS3 (`ESC O x`), or `ESC x`.
 * A carriage return or line feed is never taken into a sequence: readline drops an unbound prefix and may run the line
 * on that byte, so the guard judges the line there.
 */
function escapeLength(stream: string, start: number): number {
	const kind = stream.charAt(start + 1);
	if (kind === "" || isSubmit(kind)) return 1;
	if (kind === "O") return isSubmit(stream.charAt(start + 2)) ? 2 : Math.min(3, stream.length - start);
	if (kind !== "[") return 2;
	let end = start + 2;
	while (end < stream.length && stream.charCodeAt(end) < 0x40 && !isSubmit(stream.charAt(end))) end += 1;
	if (isSubmit(stream.charAt(end))) return end - start;
	return Math.min(end + 1, stream.length) - start;
}

/** The bytes a `bash_input` call writes, in the tool's order: the text, Enter when submitted, then the named keys. */
export function bashInputBytes(input: Record<string, unknown>): InputBytes {
	const text = typeof input.input === "string" ? input.input : undefined;
	const submit = typeof input.submit === "boolean" ? input.submit : (text?.length ?? 0) > 0;
	const keys = Array.isArray(input.keys) ? input.keys.filter((key): key is string => typeof key === "string") : [];
	let stream = text === undefined ? "" : submit ? `${text}\r` : text;
	const keyed = new Set<number>();
	for (const key of keys) {
		const data = encodeKeys([key]).data;
		const name = key.trim().toLowerCase();
		if (name !== "enter" && name !== "return")
			for (let at = 0; at < data.length; at += 1) keyed.add(stream.length + at);
		stream += data;
	}
	return { stream, keyed };
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

/**
 * Rule for a line that is not plain (a control byte other than backspace, an escape, ctrl+v, tab or a named key reached
 * it). This is the deliberate fail-closed choice: modelling readline exactly (escape lengths, quoted insert, the kill
 * ring) is a race the guard loses, so such a line is refused when the bytes sent for it could spell a kill-family
 * command however the keys rearranged them: its printable bytes hold the letters of `kill` (every kill-family name
 * needs them), or a tab followed a token tab completion could finish as one. Plain typing is never affected. It covers
 * only the agent's `bash_input` tool calls; a person typing in their own terminal never passes through this hook.
 */
function couldSpellKill(printable: string, tabbedKillPrefix: boolean): boolean {
	return tabbedKillPrefix || spellsKill(printable.toLowerCase());
}

/** The token before a tab is a non-empty prefix of a kill-family name (`k`, `pki`, `killa`). */
function isKillPrefixToken(printable: string): boolean {
	const token = (printable.split(/[ ;|&]/).at(-1) ?? "").toLowerCase();
	return token !== "" && KILL_FAMILY.some((name) => name.startsWith(token));
}

/** Ends with a backslash that is not itself escaped: the shell continues the command on the next line. */
function continuesLine(text: string): boolean {
	return (text.length - text.replace(/\\+$/, "").length) % 2 === 1;
}

/**
 * The command a held continuation and the next line make, backslash-newline removed. The two lines are also judged as
 * separate commands, in case the backslash did not continue the line (a comment, a quote).
 */
function joinContinuation(held: SubmittedLine, next: SubmittedLine): SubmittedLine {
	const head = (text: string) => (continuesLine(text) ? text.slice(0, -1) : text);
	const text = head(held.text) + next.text;
	const joined = [held.text, ...held.alternatives].flatMap((first) =>
		[next.text, ...next.alternatives].flatMap((second) => [head(first) + second, `${head(first)}\n${second}`]),
	);
	const alternatives = [...new Set(joined)].filter((candidate) => candidate !== text);
	return { text, alternatives, unfollowable: held.unfollowable || next.unfollowable };
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

/** Feeds the bytes into a background shell's line editor the way it reads them, and returns the lines it submits. */
export function typeInto(session: TypedSession, { stream, keyed }: InputBytes): TypedLines {
	const editor = new LineEditor(session.editor);
	const history = [...session.history];
	const lines: SubmittedLine[] = [];
	let { printable, plain, tabbedKillPrefix, continued } = session.pending;
	// The raw record of bytes `from`..`to`, independent of how the editor reads them.
	const record = (from: number, to: number) => {
		for (let at = from; at < to; at += 1) {
			const code = stream.charCodeAt(at);
			if (code >= 0x20 && code !== 0x7f) printable += stream.charAt(at);
			else if (code !== 0x7f && code !== 0x08) plain = false;
			if (code === 0x09 && isKillPrefixToken(printable)) tabbedKillPrefix = true;
			if (keyed.has(at)) plain = false;
		}
	};
	let index = 0;
	while (index < stream.length) {
		const char = stream.charAt(index);
		if (isSubmit(char)) {
			const before = editor.state;
			const typed = submitted(editor.submit(), before, history);
			const line = continued === undefined ? typed : joinContinuation(continued, typed);
			if (continuesLine(typed.text)) continued = line;
			else {
				const unfollowable = line.unfollowable || (!plain && couldSpellKill(printable, tabbedKillPrefix));
				lines.push({ ...line, unfollowable });
				history.push(line.text);
				({ printable, plain, tabbedKillPrefix, continued } = FRESH_PENDING);
			}
			index += char === "\r" && stream.charAt(index + 1) === "\n" ? 2 : 1;
			continue;
		}
		if (char === "\x1b") {
			const length = escapeLength(stream, index);
			(ESCAPE_KEYS[stream.slice(index, index + length)] ?? UNKNOWN_KEY)(editor);
			record(index, index + length);
			index += length;
			continue;
		}
		const key = CONTROL_KEYS[char];
		if (key !== undefined) key(editor);
		else if (char >= " ") editor.insert(char);
		else UNKNOWN_KEY(editor);
		record(index, index + 1);
		index += 1;
	}
	return {
		lines,
		session: {
			editor: editor.state,
			pending: { printable, plain, tabbedKillPrefix, continued },
			history: history.slice(-HISTORY_SIZE),
		},
	};
}
