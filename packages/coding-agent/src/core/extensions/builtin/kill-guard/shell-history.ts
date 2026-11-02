/**
 * bash's history: the guard judges the line that was typed, but for a recalled or history-expanded line bash runs a
 * history entry, and the guard cannot know the shell's history (it may hold lines loaded from the user's history file
 * before the session). Such a line is refused, not judged (fail closed): the agent can always type the command in full.
 */

/** Why a submitted line is refused without being judged. */
export type UnjudgedHistory = "recall" | "expansion";

// readline's default emacs bindings that bring a history entry, or words from one, onto the line: ctrl+p, ctrl+n,
// ctrl+r, ctrl+s; Up and Down (normal and application cursor mode); meta-<, meta->, meta-., meta-_, meta-p, meta-n,
// meta-ctrl+y (yank-nth-arg), meta-^ (history-expand-line), meta-ctrl+e (shell-expand-line); Page Up and Page Down,
// which common inputrc files bind to history search.
const HISTORY_KEYS = new Set([
	"\x10",
	"\x0e",
	"\x12",
	"\x13",
	"\x1b[A",
	"\x1bOA",
	"\x1b[B",
	"\x1bOB",
	"\x1b<",
	"\x1b>",
	"\x1b.",
	"\x1b_",
	"\x1bp",
	"\x1bn",
	"\x1b\x19",
	"\x1b^",
	"\x1b\x05",
	"\x1b[5~",
	"\x1b[6~",
]);

/** ctrl+o (operate-and-get-next): runs the line, then puts the history entry after it on the next line. */
export const OPERATE_AND_GET_NEXT = "\x0f";

/** A key (one control byte or one escape sequence) that recalls history; Up/Down with a modifier count too. */
export function isHistoryKey(sequence: string): boolean {
	return HISTORY_KEYS.has(sequence) || /^\x1b\[1;\d+[AB]$/.test(sequence);
}

// A `!` followed by one of these is not an event designator.
const NOT_AN_EVENT = new Set(["", " ", "\t", "\r", "=", "("]);

/**
 * An unquoted or double-quoted `!` that is not escaped by `\`, not right after `$` (`$!`), and not followed by a blank,
 * the line end, `=`, `(`, or the `"` that closes a double-quoted string. Single-quoted `!` is never expanded.
 */
function hasHistoryBang(line: string): boolean {
	let quote: "'" | '"' | undefined;
	for (let at = 0; at < line.length; at += 1) {
		const char = line.charAt(at);
		if (quote === "'") {
			if (char === "'") quote = undefined;
		} else if (char === "\\") at += 1;
		else if (char === "'" && quote === undefined) quote = "'";
		else if (char === '"') quote = quote === '"' ? undefined : '"';
		else if (char === "!" && line.charAt(at - 1) !== "$") {
			const next = line.charAt(at + 1);
			if (!NOT_AN_EVENT.has(next) && !(next === '"' && quote === '"')) return true;
		}
	}
	return false;
}

// Words that run the word after them as a command, so `fc` after them is still the fc builtin.
const COMMAND_PREFIXES = new Set([
	"!",
	"builtin",
	"command",
	"eval",
	"exec",
	"time",
	"nohup",
	"if",
	"then",
	"else",
	"elif",
	"do",
	"while",
	"until",
]);

/** `fc` as a command word: `fc -s` re-runs a history entry and `fc` runs the entry an editor returns. */
function runsFc(line: string): boolean {
	return line.split(/[;&|(){}`]/).some((segment) => {
		const words = segment
			.trim()
			.split(/[ \t]+/)
			.map((word) => word.replace(/["'\\]/g, ""));
		const command = words.find(
			(word) => !COMMAND_PREFIXES.has(word) && !word.startsWith("-") && !/^[A-Za-z_]\w*=/.test(word),
		);
		return command === "fc";
	});
}

/**
 * The submitted text has a history expansion candidate on any of its lines: a `!` event (see {@link hasHistoryBang}),
 * `^` as the first non-blank character (quick substitution, `^old^new`), or `fc` as a command word. A false match only
 * refuses a line the agent can retype without the expansion.
 */
export function expandsHistory(text: string): boolean {
	return text.split("\n").some((line) => /^[ \t]*\^/.test(line) || hasHistoryBang(line) || runsFc(line));
}
