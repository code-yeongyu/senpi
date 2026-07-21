/**
 * Shared constants and helpers for the persistent-terminal builtin extension.
 */

export const TERMINAL_BASH_TOOL = "bash";
export const TERMINAL_OUTPUT_TOOL = "bash_output";
export const TERMINAL_KILL_TOOL = "kill_bash";
export const TERMINAL_INPUT_TOOL = "bash_input";
export const TERMINAL_RESIZE_TOOL = "bash_resize";

/** Companion tools that must never dangle without a live PTY `bash`. */
export const TERMINAL_COMPANION_TOOLS = [
	TERMINAL_OUTPUT_TOOL,
	TERMINAL_KILL_TOOL,
	TERMINAL_INPUT_TOOL,
	TERMINAL_RESIZE_TOOL,
] as const;

export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 40;
export const DEFAULT_SCROLLBACK = 10_000;
export const DEFAULT_MAX_SESSIONS = 32;
/** Upper bound on decoded output retained per session for delta reads and `view:"log"`. */
export const MAX_SESSION_OUTPUT_CHARS = 1_000_000;
/** Grace window used to capture a background command's early output before returning its id. */
export const BACKGROUND_START_GRACE_MS = 250;
/**
 * After a foreground session has been killed (abort or timeout), how long to keep
 * waiting for its exit to settle before releasing the tool anyway. A surviving
 * descendant that holds the PTY open (or a kill that never lands) must not keep
 * the agent blocked forever.
 */
export const KILLED_SESSION_EXIT_GRACE_MS = 5000;
export const DEFAULT_OUTPUT_WAIT_TIMEOUT_SECONDS = 30;

/**
 * Non-interactive environment for foreground one-shot commands (codex-style):
 * cooperative tools (`gh`, `git`, pagers, color libs) skip spinners/colors at
 * the source instead of flooding the captured stream with redraw frames.
 * Background sessions keep the user's real TERM for interactive apps.
 */
export const FOREGROUND_ENV_OVERRIDES: Readonly<Record<string, string>> = {
	NO_COLOR: "1",
	TERM: "dumb",
	COLORTERM: "",
	PAGER: "cat",
	GIT_PAGER: "cat",
	GH_PAGER: "cat",
};

/**
 * Named-key aliases the model can send via `bash_input {keys:[...]}`. Values are the
 * raw byte sequences a PTY expects (control chars + xterm cursor/function escapes).
 */
const KEY_SEQUENCES: Record<string, string> = {
	enter: "\r",
	return: "\r",
	tab: "\t",
	escape: "\x1b",
	esc: "\x1b",
	space: " ",
	backspace: "\x7f",
	delete: "\x1b[3~",
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	home: "\x1b[H",
	end: "\x1b[F",
	pageup: "\x1b[5~",
	pagedown: "\x1b[6~",
	"ctrl+c": "\x03",
	"ctrl+d": "\x04",
	"ctrl+z": "\x1a",
	"ctrl+l": "\x0c",
	"ctrl+u": "\x15",
	"ctrl+a": "\x01",
	"ctrl+e": "\x05",
	"ctrl+\\": "\x1c",
};

/** Resolve a single named key to its PTY byte sequence, or null when unknown. */
export function resolveKeySequence(key: string): string | null {
	const normalized = key.trim().toLowerCase();
	if (normalized.length === 0) return null;
	const mapped = KEY_SEQUENCES[normalized];
	if (mapped !== undefined) return mapped;
	// Single printable character passes through verbatim.
	if ([...normalized].length === 1) return key;
	return null;
}

/** Build a PTY-ready payload from a list of named keys, returning the unknown keys too. */
export function encodeKeys(keys: readonly string[]): { data: string; unknown: string[] } {
	let data = "";
	const unknown: string[] = [];
	for (const key of keys) {
		const sequence = resolveKeySequence(key);
		if (sequence === null) unknown.push(key);
		else data += sequence;
	}
	return { data, unknown };
}

/** Compile a user-supplied regex, tolerating invalid patterns by returning null. */
export function safeRegExp(pattern: string): RegExp | null {
	try {
		return new RegExp(pattern);
	} catch {
		return null;
	}
}
