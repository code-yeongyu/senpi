/**
 * Terminal string sequences (APC `ESC _`, DCS `ESC P`, OSC `ESC ]`) end only at ST (`ESC \`, or BEL).
 * When the stdin flush timer releases the head of one before its tail is read (a slow read, or an
 * event loop that ran the timer before the pending stdin data), the tail must be dropped as part of
 * that report instead of being framed as typed text (#4352).
 */

const STRING_INTRODUCERS = ["\x1b_", "\x1bP", "\x1b]"] as const;

const C1_STRING_CONTROLS: Readonly<Record<string, string>> = {
	"\u0090": "\x1bP",
	"\u009c": "\x1b\\",
	"\u009d": "\x1b]",
	"\u009f": "\x1b_",
};

export function normalizeC1StringControls(text: string): string {
	return text.replace(/[\u0090\u009c\u009d\u009f]/g, (control) => C1_STRING_CONTROLS[control] ?? control);
}

/**
 * Whether `next`, the read after the flush timer released `released`, is the rest of the same string
 * sequence. A released bare introducer (or lone ESC) is also a legacy Alt key, and typing delivers one key
 * per read, so only a multi-character read continues it; a released introducer with a body always does.
 */
export function continuesStringSequence(released: string, next: string): boolean {
	const joined = released + next;
	return (
		STRING_INTRODUCERS.some((introducer) => joined.startsWith(introducer)) && (released.length > 2 || next.length > 1)
	);
}

export function introducerRemainderLength(released: string): number {
	return Math.max(0, 2 - released.length);
}

export type StringTailScan =
	| { readonly kind: "end"; readonly index: number }
	| { readonly kind: "pending"; readonly afterEsc: boolean };

/**
 * Finds where a string sequence body that started in an earlier read ends in `text`. `afterEsc` means the
 * previous read ended with the ESC of a possible ST. The body ends after ST or BEL; an ESC that does not
 * start ST, or any other control character, is new input and is kept.
 */
export function scanStringTail(text: string, afterEsc: boolean): StringTailScan {
	if (afterEsc && text.length > 0) return { kind: "end", index: text[0] === "\\" ? 1 : 0 };
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === 0x1b) {
			if (index + 1 === text.length) return { kind: "pending", afterEsc: true };
			return { kind: "end", index: text[index + 1] === "\\" ? index + 2 : index };
		}
		if (code === 0x07) return { kind: "end", index: index + 1 };
		if (code < 0x20 || code === 0x7f) return { kind: "end", index };
	}
	return { kind: "pending", afterEsc };
}
