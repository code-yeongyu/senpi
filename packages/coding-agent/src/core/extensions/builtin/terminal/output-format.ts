/**
 * Model-facing formatting for PTY terminal output.
 *
 * The PTY bash tools capture a raw terminal stream: escape sequences, and one
 * redraw frame per spinner tick. Returned unbounded (up to the 1 MB session
 * buffer), a single `gh run view --log-failed` injected ~1M chars of ANSI soup
 * into the conversation and forced emergency compactions. Before output
 * reaches the model it is (a) sanitized — escape sequences stripped and
 * carriage-return/backspace redraws collapsed — then (b) tail-truncated to the
 * same budget the core bash tool enforces.
 */

import { formatSize, type TruncationResult, truncateTail } from "../../../tools/truncate.ts";

/** Mirrors the core bash tool budget (`DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES`). */
export const TERMINAL_TOOL_MAX_LINES = 2000;
export const TERMINAL_TOOL_MAX_BYTES = 50 * 1024;

// Order matters: OSC can contain characters that later patterns would eat.
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const DESIGNATE_AND_SINGLE_PATTERN = /\x1b(?:[()#%*+][0-9A-Za-z]|[0-9<=>@-Z\\-_])/g;
// `\x08` (backspace) and `\r` are excluded: the redraw fold applies their semantics.
const C0_CONTROL_PATTERN = /[\x00-\x07\x0b\x0c\x0e-\x1f\x7f]/g;

function stripEscapeSequences(text: string): string {
	return text
		.replace(OSC_PATTERN, "")
		.replace(CSI_PATTERN, "")
		.replace(DESIGNATE_AND_SINGLE_PATTERN, "")
		.replace(C0_CONTROL_PATTERN, "");
}

/**
 * Fold terminal redraw semantics into a flat line: `\r` returns the cursor to
 * column 0 so spinner/progress frames overwrite each other, and `\b` steps the
 * cursor back one cell. Only the final visible state survives.
 */
function collapseRedraws(line: string): string {
	const cells: string[] = [];
	let cursor = 0;
	for (const ch of line) {
		if (ch === "\r") {
			cursor = 0;
		} else if (ch === "\b") {
			if (cursor > 0) cursor -= 1;
		} else {
			cells[cursor] = ch;
			cursor += 1;
		}
	}
	return cells.join("");
}

/** Strip escape sequences and collapse carriage-return/backspace redraws. */
export function sanitizeTerminalOutput(raw: string): string {
	return stripEscapeSequences(raw).replace(/\r\n/g, "\n").split("\n").map(collapseRedraws).join("\n");
}

export interface FormattedTerminalToolOutput {
	readonly text: string;
	readonly truncated: boolean;
	readonly truncation: TruncationResult;
}

/**
 * Sanitize `raw` PTY output and bound it to the core-bash budget, keeping the
 * tail (where exit status and errors live) with a marker when content was cut.
 */
export function formatTerminalToolOutput(raw: string): FormattedTerminalToolOutput {
	const sanitized = sanitizeTerminalOutput(raw).trimEnd();
	const truncation = truncateTail(sanitized, {
		maxLines: TERMINAL_TOOL_MAX_LINES,
		maxBytes: TERMINAL_TOOL_MAX_BYTES,
	});
	if (!truncation.truncated) {
		return { text: sanitized, truncated: false, truncation };
	}
	const marker = truncation.lastLinePartial
		? `[Showing last ${formatSize(truncation.outputBytes)} of a single line; earlier output dropped]`
		: `[Showing lines ${truncation.totalLines - truncation.outputLines + 1}-${truncation.totalLines} of ${truncation.totalLines}; earlier output dropped]`;
	return { text: `${truncation.content}\n\n${marker}`, truncated: true, truncation };
}
