import { encodeKeys } from "../terminal/shared.ts";
import type { LineEditor } from "./line-editor.ts";

/** The bytes a `bash_input` call writes and which of them a named key wrote. */
export interface InputBytes {
	readonly stream: string;
	/** Offsets in `stream` written by a named key other than enter/return. */
	readonly keyed: ReadonlySet<number>;
}

export type Key = (editor: LineEditor) => void;

/** The control bytes the line editor models; any other control byte is an unmodelled key. */
export const CONTROL_KEYS: Record<string, Key> = {
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

// ctrl+k, ctrl+u, ctrl+w: the modelled keys that kill text into the ring.
export const KILL_KEYS = new Set(["\x0b", "\x15", "\x17"]);
export const YANK = "\x19";
// meta-y: readline's yank-pop, followed as a yank of unknown text.
export const YANK_POP = new Set(["\x1by", "\x1bY"]);
// ctrl+c: readline drops the line (and a pending continuation); the kill ring is untouched.
export const ABANDON = "\x03";

/** The escape sequences the line editor models: Home, End, Left, Right and Delete. */
export const ESCAPE_KEYS: Record<string, Key> = {
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
export const UNKNOWN_KEY: Key = (editor) => editor.unfollowed(true);

export const isSubmit = (char: string) => char === "\r" || char === "\n";

/**
 * Bytes in the escape sequence at `start`: CSI (`ESC [` params, final byte 0x40-0x7e), SS3 (`ESC O x`), or `ESC x`.
 * A carriage return or line feed is never taken into a sequence: readline drops an unbound prefix and may run the line
 * on that byte, so the guard judges the line there.
 */
export function escapeLength(stream: string, start: number): number {
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
