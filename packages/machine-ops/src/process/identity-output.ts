import {
	IDENTITY_MASK,
	identitySpans,
	mayHoldIdentity,
	type Span,
	splice,
	type Undecided,
	undecidedTail,
} from "./identity-text.ts";

const HISTORY = 65536;
const HOLD = 65536;

/** Hold only the tail that can still become a masked value, never retroactively redact bytes
 * already published. A human-record credential waits for its object to close, at most HOLD
 * characters; an undecided span is released masked, never dropped. A different instance owns
 * each fd/PTY. latin1 maps every byte to one code unit, even for non-UTF8 PTYs. */
export class IdentityOutputStream {
	private pending = "";
	private history: string[] = [];
	private historySize = 0;
	private truncated = false;
	private humanHeld = false;
	private discardToken: RegExp | undefined;

	push(text: string): string {
		return this.release(text, false);
	}

	pushBytes(bytes: Uint8Array): Buffer {
		return Buffer.from(
			this.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1")),
			"latin1",
		);
	}

	finish(): string {
		return this.release("", true);
	}

	private release(text: string, end: boolean): string {
		let buf = this.pending + text;
		if (this.discardToken) {
			buf = buf.slice(buf.match(this.discardToken)?.[0].length ?? 0);
			if (!buf && !end) {
				this.pending = "";
				return "";
			}
			this.discardToken = undefined;
		}
		// Discriminators of a human record can precede its credential in released output.
		const context = this.humanHeld || /secretkey|sealedkey|\\u/i.test(buf) ? this.history.join("") : "";
		const all = context + buf;
		const base = context.length;
		const undecided: Undecided = { open: [], orphan: [] };
		const found = context || mayHoldIdentity(buf) ? identitySpans(all, undecided) : [];
		const tail = undecidedTail(all, base);
		let hold = end ? all.length : tail.start;
		const open = undecided.open.filter((s) => s.start >= base);
		const firstOpen = Math.min(...open.map((s) => s.start));
		this.humanHeld = !end && open.length > 0 && all.length - firstOpen <= HOLD;
		if (this.humanHeld) hold = Math.min(hold, firstOpen);
		const masks: Span[] = [...found, ...open, ...(this.truncated ? undecided.orphan : [])];
		if (end && tail.value !== undefined)
			masks.push({ start: tail.value, end: all.length, replacement: IDENTITY_MASK });
		const released = all.slice(base, hold);
		const out = splice(
			released,
			masks
				.filter((s) => s.start >= base && s.start < hold)
				.map((s) => ({ ...s, start: s.start - base, end: Math.min(s.end, hold) - base })),
		);
		// A token that runs to the end of the released text continues into the next chunk.
		const token = found.find(
			(s) =>
				s.end === all.length &&
				s.replacement === IDENTITY_MASK &&
				/^(?:tvk1:|age-)/i.test(all.slice(s.start, s.start + 5)),
		);
		if (!end && hold === all.length && token)
			this.discardToken = /^tvk1:/i.test(all.slice(token.start, token.start + 5)) ? /^[a-z\d_=-]*/i : /^[a-z\d]*/i;
		this.pending = all.slice(hold);
		this.remember(released);
		return out;
	}

	private remember(released: string): void {
		if (!released) return;
		this.history.push(released);
		this.historySize += released.length;
		while (this.history.length > 1 && this.historySize - (this.history[0]?.length ?? 0) >= HISTORY) {
			this.historySize -= this.history.shift()?.length ?? 0;
			this.truncated = true;
		}
		if (this.historySize > 2 * HISTORY) {
			const kept = this.history.join("").slice(-HISTORY);
			this.history = [kept];
			this.historySize = kept.length;
			this.truncated = true;
		}
	}
}
