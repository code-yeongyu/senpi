/**
 * DeepSeek DSML tool-call envelopes (`<｜DSML｜invoke name="...">`, `</｜DSML｜parameter>`) are tool-call syntax
 * the model sometimes emits inside its reasoning stream. They are not reasoning: kept in a thinking block, they
 * are shown to the user, replayed to the model on the next request, and imitated until the reply collapses
 * (senpi#4621). This filter removes the envelopes from a reasoning stream as it arrives and keeps every
 * character outside them: prose next to DSML-shaped text is never lost and never held without bound.
 *
 * - Envelope text is dropped only when the envelope's own outermost closing tag arrives; nothing is dropped on
 *   suspicion. An envelope still open when the stream ends was quoted: its held text is released, tags removed. A
 *   hold that passes `LONE_HOLD_CHARS` is released the same way, so the display never stalls without bound.
 * - Nesting is strict: a closing tag pops only the innermost open tag of the same name; any other closing tag is
 *   ignored. Inside a confirmed envelope's `parameter` value every DSML tag is value text, not structure, so a
 *   quoted tag in a tool argument can neither close the envelope early nor keep it open.
 * - A second opening tag after only whitespace nests (`invoke` > `parameter`): the envelope is confirmed tool
 *   syntax. A second opening tag after real prose means the first tag was quoted: that prose is released at once
 *   and the new tag becomes the lone tag.
 * - A closing tag with nothing open is dropped; an opening tag that never completes at the end of the stream is
 *   released as text.
 */

const MARKER_BODY = "DSML";
const BARS = ["\uFF5C", "|"] as const;
const OPEN_MARKERS = BARS.map((bar) => `<${bar}${MARKER_BODY}${bar}`);
const CLOSE_MARKERS = BARS.map((bar) => `</${bar}${MARKER_BODY}${bar}`);
const ALL_MARKERS = [...OPEN_MARKERS, ...CLOSE_MARKERS];
/** A DSML tag longer than this without a closing `>` is not a tag; its text is kept. */
const MAX_TAG_CHARS = 512;
/** Text held inside an open envelope; past this the envelope counts as quoted and the text is released. */
export const LONE_HOLD_CHARS = 64 * 1024;
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
	/** Text inside the open envelope, dropped when it closes and released if it never does. */
	#held = "";
	/** The open envelope nests tags, so it is tool syntax and its `parameter` values are opaque. */
	#confirmed = false;

	/** Feed one stream delta; returns the reasoning text that is safe to show and store now. */
	push(delta: string): string {
		this.#pending += delta;
		return this.#drain(false);
	}

	/** End of the stream: an envelope still open was quoted, so its held text is released. */
	finish(): string {
		const out = this.#drain(true);
		const released = out + this.#held;
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
export function mayContainDsml(text: string): boolean {
	return text.includes(MARKER_BODY);
}

/** Complete-text form of `DsmlEnvelopeFilter`: equal to streaming `text` through it in any split. */
export function stripDsmlEnvelopes(text: string): string {
	if (!mayContainDsml(text)) return text;
	const filter = new DsmlEnvelopeFilter();
	return filter.push(text) + filter.finish();
}
