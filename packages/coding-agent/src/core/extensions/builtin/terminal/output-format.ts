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

import type { TextContent } from "@earendil-works/pi-ai";
import { modelOnlyText } from "../../../tools/model-only-text.ts";
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
	/** Model-facing text: the kept output, then the truncation marker when content was cut. */
	readonly text: string;
	/** The kept output alone, without the marker. */
	readonly body: string;
	/** Truncation marker addressed to the model; UIs never render it. */
	readonly marker?: string;
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
		return { text: sanitized, body: sanitized, truncated: false, truncation };
	}
	const marker = truncation.lastLinePartial
		? `[Showing last ${formatSize(truncation.outputBytes)} of a single line; earlier output dropped]`
		: `[Showing lines ${truncation.totalLines - truncation.outputLines + 1}-${truncation.totalLines} of ${truncation.totalLines}; earlier output dropped]`;
	return { text: `${truncation.content}\n\n${marker}`, body: truncation.content, marker, truncated: true, truncation };
}

/**
 * Split a tool-result text into parts so each notice becomes its own model-only
 * part. Providers join a tool result's text parts with "\n", so every notice
 * must sit on its own line: the newline before it (and after it, when text
 * follows) is taken out of the neighbouring parts and restored by that join.
 * The joined parts are therefore byte-identical to `text`. A notice that is
 * absent or not line-delimited leaves `text` as one visible part.
 */
export function splitModelOnlyNotices(text: string, notices: ReadonlyArray<string | undefined>): TextContent[] {
	const parts: TextContent[] = [];
	let cursor = 0;
	// True when the previous part is a notice whose trailing newline was consumed.
	let afterNotice = false;
	for (const notice of notices) {
		if (notice === undefined || notice.length === 0) continue;
		const index = text.indexOf(notice, cursor);
		if (index < 0) continue;
		const end = index + notice.length;
		if (end < text.length && text[end] !== "\n") continue;
		if (afterNotice && index === cursor) {
			parts.push(modelOnlyText(notice));
		} else if (index > cursor && text[index - 1] === "\n") {
			parts.push({ type: "text", text: text.slice(cursor, index - 1) }, modelOnlyText(notice));
		} else {
			continue;
		}
		cursor = end < text.length ? end + 1 : end;
		afterNotice = end < text.length;
	}
	if (parts.length === 0) return [{ type: "text", text }];
	if (cursor < text.length || text[text.length - 1] === "\n") parts.push({ type: "text", text: text.slice(cursor) });
	return parts;
}
