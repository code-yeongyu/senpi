/**
 * Reads one source between refreshes into complete, clean lines.
 * Ported from oh-my-pi 9df0457b31 (MIT, Copyright Can Boluk et al.).
 */
import type { JobTextSource } from "./source-types.ts";

/** Longest line kept; longer lines are cut. */
export const MAX_LINE_CHARS = 4096;

const ANSI_SEQUENCE =
	/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|\x9b[0-?]*[ -/]*[@-~]/g;
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
/** An escape sequence the line in progress has not finished yet. */
const UNFINISHED_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*)?$/;
/**
 * A long token-shaped run at the very end of a progress segment may be a secret cut mid-write, which
 * no line redactor recognizes yet; it is held back until the segment is complete.
 */
const OPEN_TOKEN_TAIL = /[A-Za-z0-9_-]{16,}$/;

/** A line without terminal escape sequences and control characters (tabs stay). */
function sanitizeLine(line: string): string {
	return line.replace(ANSI_SEQUENCE, "").replace(CONTROL_CHARS, "");
}

/**
 * One source's redaction, fed its complete lines in order (`JobWidgetSourceRedactor`): `cut` marks
 * text the source dropped unread, `finish` the end of the source. A key spans lines, so a fresh
 * redactor per line would miss it.
 */
export interface SourceLineRedactor {
	push(line: string): string[];
	cut(): string[];
	finish(): string[];
}

export interface SourceLines {
	lines: string[];
	open: boolean;
	/** Offset just past the read text (the source's size so far). */
	end: number;
}

/**
 * Keeps a cursor, carries the trailing partial line to the next read, turns CR and CRLF into line
 * breaks, strips ANSI and control characters, and cuts lines at {@link MAX_LINE_CHARS}. When the
 * source dropped text the reader never saw, the torn line at the gap is skipped so no rule reads
 * half a line. With a redactor, lines are redacted before they are cut, so a cut never splits a
 * secret's marker.
 */
export class SourceLineReader {
	readonly source: JobTextSource;
	#cursor = 0;
	/** Raw text of the line in progress; sanitized once complete so split escapes still strip. */
	#partial = "";
	/** The line in progress follows a bare CR: a progress redraw (`30%`), not a line still being written. */
	#partialAfterCr = false;
	#torn = false;
	readonly #redactor: SourceLineRedactor | undefined;

	constructor(source: JobTextSource, redactor?: SourceLineRedactor) {
		this.source = source;
		this.#redactor = redactor;
	}

	/** New complete lines; `flush` also ends the line in progress. */
	read(flush: boolean): SourceLines {
		const chunk = this.source.read(this.#cursor);
		let text = chunk.text;
		const skipped = chunk.start > this.#cursor;
		if (skipped) {
			this.#partial = "";
			this.#torn = true;
		}
		this.#cursor = Math.max(this.#cursor, chunk.end);
		if (this.#torn) {
			const lineEnd = /\r\n|\r|\n/.exec(text);
			if (lineEnd === null) text = "";
			else {
				text = text.slice(lineEnd.index + lineEnd[0].length);
				this.#torn = false;
			}
		}
		const combined = this.#partial + text;
		const lastBreak = Math.max(combined.lastIndexOf("\r"), combined.lastIndexOf("\n"));
		if (lastBreak >= 0) this.#partialAfterCr = combined[lastBreak] === "\r";
		const raw = combined.replace(/\r\n?/g, "\n").split("\n");
		this.#partial = (raw.pop() ?? "").slice(0, MAX_LINE_CHARS * 2);
		if ((flush || !chunk.open) && this.#partial.length > 0) {
			raw.push(this.#partial);
			this.#partial = "";
		}
		const clean = raw.map(sanitizeLine);
		const redactor = this.#redactor;
		const redacted = redactor
			? [
					...(skipped ? redactor.cut() : []),
					...clean.flatMap((line) => redactor.push(line)),
					...(flush || !chunk.open ? redactor.finish() : []),
				]
			: clean;
		const lines = redacted.map((line) => line.slice(0, MAX_LINE_CHARS));
		return { lines, open: chunk.open, end: chunk.end };
	}

	/**
	 * The newest CR segment of the line in progress, sanitized: a progress bar redraws with CR and only
	 * completes on the next one, so without it the view shows the previous step. Never matched by rules.
	 */
	get progress(): string | undefined {
		if (!this.#partialAfterCr || this.#partial.length === 0) return undefined;
		const line = sanitizeLine(this.#partial.replace(UNFINISHED_ESCAPE, ""))
			.slice(0, MAX_LINE_CHARS)
			.replace(OPEN_TOKEN_TAIL, "")
			.trim();
		return line.length > 0 ? line : undefined;
	}
}
