/**
 * DeepSeek DSML tool-call envelopes (`<｜DSML｜invoke name="...">`, `</｜DSML｜parameter>`) are tool-call syntax
 * the model sometimes emits inside its reasoning stream. They are not reasoning: kept in a thinking block, they
 * are shown to the user, replayed to the model on the next request, and imitated until the reply collapses
 * (senpi#4621). This filter removes the envelopes from a reasoning stream as it arrives and keeps every
 * character outside them: prose next to DSML-shaped text is never lost and never held without bound.
 *
 * Two states, no third:
 * - A CONFIRMED envelope is real tool syntax: an opening tag followed, after only whitespace, by a nested DSML
 *   opening tag (`invoke` > `parameter`). Everything from the outer opening tag is dropped as it streams, with
 *   no hold and no size cap, until the envelope's open tags are all closed or the stream ends. Inside it a
 *   closing tag pops only the innermost open tag of the same name, and inside a `parameter` value every DSML
 *   tag except `</parameter>` is value text, so a stray or quoted closing tag can never end the envelope early.
 * - An UNCONFIRMED lone tag may be prose that quotes a tag. The text after it is held, at most
 *   `LONE_HOLD_CHARS`, and released as text (the tag removed) when the stream ends, when the hold passes the
 *   cap, or when real prose followed by a new tag shows the first tag was quoted. Its own closing tag makes it
 *   an envelope after all, and the held text is dropped; any other closing tag is ignored.
 * Accepted trade-off: prose that quotes two nested tags with only whitespace between them and never closes them
 * looks exactly like real tool syntax, so it is treated as a confirmed envelope and dropped. That is rare, and
 * releasing a real tool argument into thinking and replay (the bug this filter exists for) is worse.
 * A closing tag with nothing open is dropped; an opening tag that never completes at the end of the stream is
 * released as text unless it is inside a confirmed envelope.
 */

const MARKER_BODY = "DSML";
const BARS = ["\uFF5C", "|"] as const;
const OPEN_MARKERS = BARS.map((bar) => `<${bar}${MARKER_BODY}${bar}`);
const CLOSE_MARKERS = BARS.map((bar) => `</${bar}${MARKER_BODY}${bar}`);
const ALL_MARKERS = [...OPEN_MARKERS, ...CLOSE_MARKERS];
/** A DSML tag longer than this without a closing `>` is not a tag; its text is kept. */
const MAX_TAG_CHARS = 512;
/** Text held after an unconfirmed lone tag; past this the tag counts as quoted and the text is released. */
const LONE_HOLD_CHARS = 64 * 1024;
/** The DSML tag whose body is a tool argument value. */
const PAYLOAD_TAG = "parameter";
const TAG_NAME = /^\s*([A-Za-z_]+)/;
const NON_WHITESPACE = /\S/;

type MarkerMatch =
	| { readonly kind: "full"; readonly closing: boolean; readonly length: number }
	| { readonly kind: "partial" }
	| null;

function matchMarker(text: string, start: number): MarkerMatch {
	const rest = text.length - start;
	for (const marker of ALL_MARKERS) {
		if (rest >= marker.length) {
			if (text.startsWith(marker, start))
				return { kind: "full", closing: marker.startsWith("</"), length: marker.length };
		} else if (marker.startsWith(text.slice(start))) {
			return { kind: "partial" };
		}
	}
	return null;
}

export class DsmlEnvelopeFilter {
	#pending = "";
	/** Names of the open tags, outermost first; empty outside an envelope. */
	#open: string[] = [];
	/** Text after an unconfirmed lone tag, dropped if the tag closes and released if it never does. */
	#held = "";
	/** The open envelope nests tags: it is tool syntax and is dropped as it streams. */
	#confirmed = false;

	/** Feed one stream delta; returns the reasoning text that is safe to show and store now. */
	push(delta: string): string {
		this.#pending += delta;
		return this.#drain(false);
	}

	/** End of the stream: an unconfirmed lone tag was quoted (held text released); a confirmed envelope stays dropped. */
	finish(): string {
		const out = this.#drain(true);
		const released = this.#confirmed ? out : out + this.#held;
		this.#reset();
		return released;
	}

	#reset(): void {
		this.#open = [];
		this.#held = "";
		this.#confirmed = false;
	}

	#emit(out: string[], text: string): void {
		if (text.length === 0) return;
		if (this.#open.length === 0) {
			out.push(text);
			return;
		}
		if (this.#confirmed) return;
		this.#held += text;
		if (this.#held.length > LONE_HOLD_CHARS) {
			out.push(this.#held);
			this.#reset();
		}
	}

	#openTag(out: string[], name: string): void {
		const innermost = this.#open.at(-1);
		if (innermost === undefined) {
			this.#open = [name];
			return;
		}
		if (this.#confirmed && innermost === PAYLOAD_TAG) return;
		if (!this.#confirmed && this.#open.length === 1 && NON_WHITESPACE.test(this.#held)) {
			out.push(this.#held);
			this.#held = "";
			this.#open = [name];
			return;
		}
		this.#confirmed = true;
		this.#held = "";
		this.#open.push(name);
	}

	#closeTag(name: string): void {
		if (this.#open.at(-1) !== name) return;
		this.#open.pop();
		if (this.#open.length === 0) this.#reset();
	}

	#drain(final: boolean): string {
		const out: string[] = [];
		const text = this.#pending;
		let index = 0;
		while (index < text.length) {
			const lt = text.indexOf("<", index);
			if (lt === -1) {
				this.#emit(out, text.slice(index));
				index = text.length;
				break;
			}
			this.#emit(out, text.slice(index, lt));
			index = lt;
			const marker = matchMarker(text, lt);
			if (marker === null) {
				this.#emit(out, "<");
				index = lt + 1;
				continue;
			}
			if (marker.kind === "partial") {
				if (final) {
					this.#emit(out, text.slice(lt));
					index = text.length;
				}
				break;
			}
			const gt = text.indexOf(">", lt);
			if (gt === -1 || gt - lt > MAX_TAG_CHARS) {
				if (gt === -1 && text.length - lt <= MAX_TAG_CHARS) {
					if (final) {
						this.#emit(out, text.slice(lt));
						index = text.length;
					}
					break;
				}
				this.#emit(out, "<");
				index = lt + 1;
				continue;
			}
			const name = TAG_NAME.exec(text.slice(lt + marker.length, gt))?.[1] ?? "";
			if (marker.closing) this.#closeTag(name);
			else if (text[gt - 1] !== "/") this.#openTag(out, name);
			index = gt + 1;
		}
		this.#pending = text.slice(index);
		return out.join("");
	}
}

/** Whether `text` may carry a DSML envelope; a cheap guard before running the filter. */
function mayContainDsml(text: string): boolean {
	return text.includes(MARKER_BODY);
}

/** Complete-text form of `DsmlEnvelopeFilter`: equal to streaming `text` through it in any split. */
export function stripDsmlEnvelopes(text: string): string {
	if (!mayContainDsml(text)) return text;
	const filter = new DsmlEnvelopeFilter();
	return filter.push(text) + filter.finish();
}
