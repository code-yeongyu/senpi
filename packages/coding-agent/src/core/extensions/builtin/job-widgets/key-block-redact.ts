/**
 * The built-in private-key rule, applied whatever the session's secret setting: a key spans lines,
 * so it is recognized per source, across that source's lines in order, never one line at a time.
 * Everything from a `-----BEGIN … PRIVATE KEY-----` (or `PGP PRIVATE KEY BLOCK`) marker through
 * its matching END marker, or through the end of the source when none comes, becomes one
 * {@link PRIVATE_KEY_MARKER}. A window can start inside a key (a sample cut, or text the source
 * dropped, took the BEGIN line), so a run of base64 body lines followed by an END marker is
 * redacted with that marker, and a run still open where the window is cut is redacted too.
 *
 * Body lines may carry a per-line prefix (`docker logs -t` and `kubectl logs --timestamps` put a
 * timestamp before every line, a log multiplexer a `[pod] ` tag). A line is read as a prefix and the
 * base64 token ending it; a run holds consecutive lines whose prefixes have the same shape (digit
 * runs collapsed, so successive timestamps compare equal). A bare run starts on a token of 16+
 * base64 characters with both cases, so hex hashes and plain words never start one; a prefixed run
 * needs a full-width body line ({@link PREFIXED_BODY_MIN} characters), so an ordinary line ending in
 * a token (`deploy with ghp_…`) is not held back from the view.
 */
export const PRIVATE_KEY_MARKER = "[REDACTED private key]";

const LABEL = String.raw`((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)`;
const BEGIN = new RegExp(`-----BEGIN ${LABEL}-----`);
const END = new RegExp(`-----END ${LABEL}-----`);
/** A token that may start key body (PEM wraps at 64, OpenSSH at 70, one-line bodies run longer); see {@link startsBody}. */
const BODY = /^[A-Za-z0-9+/]{16,}={0,2}$/;
/** PEM wraps body lines at 64 columns, OpenSSH at 70: a prefixed run starts only on a line this long. */
const PREFIXED_BODY_MIN = 60;
const UPPER = /[A-Z]/;
const LOWER = /[a-z]/;
/** Once a run started: a short last body line, or a PGP armor checksum (`=` and four base64 characters). */
const BODY_CONTINUED = /^(?:[A-Za-z0-9+/]+={0,2}|=[A-Za-z0-9+/]{4})$/;
/** Armor headers inside a key block (`Proc-Type`, `DEK-Info`, `Version`, `Comment`). */
const ARMOR_HEADER = /^[A-Za-z][A-Za-z0-9-]*: \S/;
const BASE64_RUN = /[A-Za-z0-9+/]{40,}/;
/** Held lines are bounded; no key body is this long, so a longer run is a dump and its oldest line goes out. */
const MAX_HELD_LINES = 512;

function isBase64Char(code: number): boolean {
	return (
		(code >= 65 && code <= 90) ||
		(code >= 97 && code <= 122) ||
		(code >= 48 && code <= 57) ||
		code === 43 ||
		code === 47
	);
}

/** A per-line prefix as a shape: trimmed, digit runs collapsed, so `12:00:00.1Z` and `12:00:01.25Z` agree. */
function prefixShape(prefix: string): string {
	return prefix.trim().replace(/\d+/g, "0");
}

interface BodyParts {
	/** The shape of the text before the token; `""` for a bare line. */
	readonly shape: string;
	readonly token: string;
}

/**
 * A line split into its prefix and the base64 token ending it (a padded run, or a PGP armor
 * checksum `=` plus four characters), or `undefined` when it ends in none. Scans back from the end
 * once, so a long line costs linear time.
 */
function bodyParts(line: string): BodyParts | undefined {
	const trimmed = line.trim();
	let start = trimmed.length;
	let pad = 0;
	while (start > 0 && pad < 2 && trimmed[start - 1] === "=") {
		start--;
		pad++;
	}
	const runEnd = start;
	while (start > 0 && isBase64Char(trimmed.charCodeAt(start - 1))) start--;
	if (start === runEnd) return undefined;
	if (pad === 0 && runEnd - start === 4 && trimmed[start - 1] === "=") start--;
	return { shape: prefixShape(trimmed.slice(0, start)), token: trimmed.slice(start) };
}

/** A line that can open a held run: base64 with both cases (no hex hash, no plain word), full width when prefixed. */
function startsBody(parts: BodyParts): boolean {
	const { shape, token } = parts;
	if (shape.length > 0 && token.length < PREFIXED_BODY_MIN) return false;
	return BODY.test(token) && UPPER.test(token) && LOWER.test(token);
}

/**
 * Whether a line inside a key block that crossed a gap can still belong to the key; `shape` is the
 * prefix shape of the block's BEGIN line, which every body line of a prefixed log repeats.
 */
function keyLike(line: string, shape: string): boolean {
	const trimmed = line.trim();
	if (trimmed.length === 0 || BODY_CONTINUED.test(trimmed) || ARMOR_HEADER.test(trimmed) || BASE64_RUN.test(trimmed)) {
		return true;
	}
	if (shape.length === 0) return false;
	// A blank line under the prefix (`docker logs -t` prints the timestamp alone).
	if (prefixShape(trimmed) === shape) return true;
	const parts = bodyParts(trimmed);
	return parts !== undefined && parts.shape === shape && BODY_CONTINUED.test(parts.token);
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
	/** Prefix shape of the open block's BEGIN line. */
	#blockShape = "";
	/** The source skipped text inside the block: a line that cannot be key material proves the END was skipped. */
	#blockCrossedGap = false;
	/** Text was skipped since the last non-body line: a held run may be a key whose BEGIN marker was skipped. */
	#gapBeforeHeld = false;
	#held: string[] = [];
	/** Prefix shape every held line shares. */
	#heldShape = "";

	push(line: string): string[] {
		if (this.#block === undefined) {
			const parts = bodyParts(line);
			if (parts && this.#held.length > 0 && parts.shape === this.#heldShape && BODY_CONTINUED.test(parts.token)) {
				return this.#hold(line);
			}
			if (parts && startsBody(parts)) {
				// A run under another prefix ends here; no ordinary line came between, so the gap flag stays.
				const out = this.#releaseHeld();
				this.#heldShape = parts.shape;
				out.push(...this.#hold(line));
				return out;
			}
		}
		const out: string[] = [];
		if (this.#block === undefined && startsWithEnd(line)) this.#held = [];
		else out.push(...this.#releaseHeld());
		// Blank and armor-header lines sit between a BEGIN marker line and its body, so they keep the gap mark.
		const trimmed = line.trim();
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

	#hold(line: string): string[] {
		this.#held.push(line);
		return this.#held.length > MAX_HELD_LINES ? [this.#held.shift() as string] : [];
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
				if (this.#blockCrossedGap && !keyLike(rest, this.#blockShape)) {
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
				this.#blockShape = prefixShape(rest.slice(0, begin.index));
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
