/**
 * DeepSeek DSML tool-call envelopes (`<｜DSML｜invoke name="...">`, `</｜DSML｜parameter>`) are tool-call syntax
 * the model sometimes emits inside its reasoning stream. They are not reasoning: kept in a thinking block, they
 * are shown to the user, replayed to the model on the next request, and imitated until the reply collapses
 * (senpi#4621). This filter removes the envelopes from a reasoning stream as it arrives and keeps every
 * character outside them.
 *
 * An envelope is everything from an opening DSML tag to the closing tag that brings the nesting depth back to
 * zero, tags included. Tag names are not matched against each other: a degenerate stream closes `calls` with
 * `parameter`, and depth alone is what tells envelope from reasoning. Text inside an envelope that never closes
 * is released as reasoning at `finish()` or once it exceeds `MAX_HELD_CHARS`, so a stray opening tag never
 * swallows real thinking.
 */

const MARKER_BODY = "DSML";
const BARS = ["\uFF5C", "|"] as const;
const OPEN_MARKERS = BARS.map((bar) => `<${bar}${MARKER_BODY}${bar}`);
const CLOSE_MARKERS = BARS.map((bar) => `</${bar}${MARKER_BODY}${bar}`);
const ALL_MARKERS = [...OPEN_MARKERS, ...CLOSE_MARKERS];
/** A DSML tag longer than this without a closing `>` is not a tag; its text is kept. */
const MAX_TAG_CHARS = 512;
/** Envelope text held for an unclosed envelope; past this it is released as reasoning. */
const MAX_HELD_CHARS = 4096;

type MarkerMatch = { readonly kind: "full"; readonly closing: boolean } | { readonly kind: "partial" } | null;

function matchMarker(text: string, start: number): MarkerMatch {
	const rest = text.length - start;
	for (const marker of ALL_MARKERS) {
		if (rest >= marker.length) {
			if (text.startsWith(marker, start)) return { kind: "full", closing: marker.startsWith("</") };
		} else if (marker.startsWith(text.slice(start))) {
			return { kind: "partial" };
		}
	}
	return null;
}

export class DsmlEnvelopeFilter {
	#pending = "";
	#depth = 0;
	#held = "";

	/** Feed one stream delta; returns the reasoning text that is safe to show and store now. */
	push(delta: string): string {
		this.#pending += delta;
		return this.#drain(false);
	}

	/** End of the stream: releases held text of an unclosed envelope and an undecided partial marker. */
	finish(): string {
		const out = this.#drain(true);
		const released = out + this.#held;
		this.#held = "";
		this.#depth = 0;
		return released;
	}

	#emit(out: string[], text: string): void {
		if (text.length === 0) return;
		if (this.#depth === 0) {
			out.push(text);
			return;
		}
		this.#held += text;
		if (this.#held.length > MAX_HELD_CHARS) {
			out.push(this.#held);
			this.#held = "";
			this.#depth = 0;
		}
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
			if (gt === -1) {
				if (text.length - lt > MAX_TAG_CHARS) {
					this.#emit(out, text.slice(lt, lt + 1));
					index = lt + 1;
					continue;
				}
				// An incomplete DSML tag at the end of the stream is dropped: it is envelope syntax, not reasoning.
				if (final) index = text.length;
				break;
			}
			if (gt - lt > MAX_TAG_CHARS) {
				this.#emit(out, "<");
				index = lt + 1;
				continue;
			}
			const selfClosing = text[gt - 1] === "/";
			if (marker.closing) {
				if (this.#depth > 0) {
					this.#depth -= 1;
					if (this.#depth === 0) this.#held = "";
				}
			} else if (!selfClosing) {
				this.#depth += 1;
			}
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
