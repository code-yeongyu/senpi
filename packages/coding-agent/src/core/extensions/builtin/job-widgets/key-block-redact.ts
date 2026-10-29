/**
 * The built-in private-key rule, applied whatever the session's secret setting: a key spans lines,
 * so it is recognized per source, across that source's lines in order, never one line at a time.
 * Everything from a `-----BEGIN … PRIVATE KEY-----` (or `PGP PRIVATE KEY BLOCK`) marker through
 * its matching END marker, or through the end of the source when none comes, becomes one
 * {@link PRIVATE_KEY_MARKER}. A window can start inside a key (a sample cut, or text the source
 * dropped, took the BEGIN line), so a run of base64 body lines followed by an END marker is
 * redacted with that marker, and a run still open where the window is cut is redacted too.
 */
export const PRIVATE_KEY_MARKER = "[REDACTED private key]";

const LABEL = String.raw`((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)`;
const BEGIN = new RegExp(`-----BEGIN ${LABEL}-----`);
const END = new RegExp(`-----END ${LABEL}-----`);
/** A line that may be key body: base64 alone on it (PEM wraps at 64, OpenSSH at 70, one-line bodies run longer). */
const BODY = /^[A-Za-z0-9+/]{16,}={0,2}$/;
/** Once a run started: a short last body line, or a PGP armor checksum (`=` and four base64 characters). */
const BODY_CONTINUED = /^(?:[A-Za-z0-9+/]+={0,2}|=[A-Za-z0-9+/]{4})$/;
/** Armor headers inside a key block (`Proc-Type`, `DEK-Info`, `Version`, `Comment`). */
const ARMOR_HEADER = /^[A-Za-z][A-Za-z0-9-]*: \S/;
const BASE64_RUN = /[A-Za-z0-9+/]{40,}/;
/** Held lines are bounded; no key body is this long, so a longer run is a dump and its oldest line goes out. */
const MAX_HELD_LINES = 512;

/** Whether a line inside a key block that crossed a gap can still belong to the key. */
function keyLike(line: string): boolean {
	const trimmed = line.trim();
	return (
		trimmed.length === 0 || BODY_CONTINUED.test(trimmed) || ARMOR_HEADER.test(trimmed) || BASE64_RUN.test(trimmed)
	);
}

/** Whether the line's first private-key marker is an END: the key began before what this source shows. */
function startsWithEnd(line: string): boolean {
	const end = END.exec(line);
	if (!end) return false;
	const begin = BEGIN.exec(line);
	return !begin || end.index < begin.index;
}

/**
 * One source's private-key filter: fed that source's lines in order, it returns the lines to keep.
 * It holds a run of body-shaped lines until the line after the run shows whether an END marker
 * closes it.
 */
export class PrivateKeyLineFilter {
	/** Label of the open BEGIN marker while inside a key block. */
	#block: string | undefined;
	/** The source skipped text inside the block: a line that cannot be key material proves the END was skipped. */
	#blockCrossedGap = false;
	/** Text was skipped since the last non-body line: a held run may be a key whose BEGIN marker was skipped. */
	#gapBeforeHeld = false;
	#held: string[] = [];

	push(line: string): string[] {
		const trimmed = line.trim();
		if (
			this.#block === undefined &&
			(BODY.test(trimmed) || (this.#held.length > 0 && BODY_CONTINUED.test(trimmed)))
		) {
			this.#held.push(line);
			return this.#held.length > MAX_HELD_LINES ? [this.#held.shift() as string] : [];
		}
		const out: string[] = [];
		if (this.#block === undefined && startsWithEnd(line)) this.#held = [];
		else out.push(...this.#releaseHeld());
		// Blank and armor-header lines sit between a BEGIN marker line and its body, so they keep the gap mark.
		if (trimmed !== "" && !ARMOR_HEADER.test(trimmed)) this.#gapBeforeHeld = false;
		const kept = this.#scan(line);
		if (kept !== undefined) out.push(kept);
		return out;
	}

	/**
	 * The source skipped text here (a sample window ends, or the source dropped text unread). A held
	 * run may have met its END marker in the skipped text, so it is redacted; an open block stays open.
	 */
	cut(): string[] {
		if (this.#block !== undefined) this.#blockCrossedGap = true;
		this.#gapBeforeHeld = true;
		if (this.#held.length === 0) return [];
		this.#held = [];
		return [PRIVATE_KEY_MARKER];
	}

	/** The source ended: a held run met no END marker, so it is released. The filter starts over. */
	finish(): string[] {
		const out = this.#releaseHeld();
		this.#block = undefined;
		this.#blockCrossedGap = false;
		this.#gapBeforeHeld = false;
		return out;
	}

	/** The held run as output: a run that began after skipped text may be a key body, so it is redacted. */
	#releaseHeld(): string[] {
		const held = this.#held;
		this.#held = [];
		if (held.length === 0) return [];
		return this.#gapBeforeHeld ? [PRIVATE_KEY_MARKER] : held;
	}

	/** What remains of `line` once key blocks are replaced, or `undefined` when nothing of it remains. */
	#scan(line: string): string | undefined {
		let rest = line;
		let kept = "";
		let touched = false;
		let marked = false;
		for (;;) {
			if (this.#block !== undefined) {
				touched = true;
				const close = `-----END ${this.#block}-----`;
				const at = rest.indexOf(close);
				if (at !== -1) {
					this.#closeBlock();
					rest = rest.slice(at + close.length);
					continue;
				}
				if (this.#blockCrossedGap && !keyLike(rest)) {
					this.#closeBlock();
					continue;
				}
				break;
			}
			const begin = BEGIN.exec(rest);
			const end = END.exec(rest);
			if (end && (!begin || end.index < begin.index)) {
				// Text before an END marker with no BEGIN before it may be the key's last body characters.
				kept += PRIVATE_KEY_MARKER;
				touched = marked = true;
				rest = rest.slice(end.index + end[0].length);
				continue;
			}
			if (begin) {
				kept += rest.slice(0, begin.index) + PRIVATE_KEY_MARKER;
				touched = marked = true;
				this.#block = begin[1];
				rest = rest.slice(begin.index + begin[0].length);
				continue;
			}
			kept += rest;
			break;
		}
		if (!touched) return line;
		return marked || kept.trim().length > 0 ? kept : undefined;
	}

	#closeBlock(): void {
		this.#block = undefined;
		this.#blockCrossedGap = false;
	}
}
