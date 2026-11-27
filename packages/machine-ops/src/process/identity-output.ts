import {
	IDENTITY_MASK,
	identitySpans,
	MAX_GAP,
	mayHoldIdentity,
	type Span,
	splice,
	type Undecided,
	undecidedTail,
} from "./identity-text.ts";
import { ScopeState } from "./identity-scope.ts";

const HISTORY = 65536;
const HOLD = 65536;
// Covers a private name with both bounded separators, so a released name still meets its value.
const RELEASE_CONTEXT = 4 * MAX_GAP;

/** Hold only the tail that can still become a masked value, never retroactively redact bytes
 * already published. A human-record credential waits for its object to close, at most HOLD
 * characters; an undecided span is released masked, never dropped. A different instance owns
 * each fd/PTY. latin1 maps every byte to one code unit, even for non-UTF8 PTYs. */
export class IdentityOutputStream {
	private pending = "";
	// Released text kept for context, each with the parser state at its first character.
	private history = "";
	private readonly historyStart = new ScopeState();
	private recent = "";
	private readonly recentStart = new ScopeState();
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

	finishBytes(): Buffer {
		return Buffer.from(this.finish(), "latin1");
	}

	/** After a pause, release a held name or token prefix: alone it is public, and the
	 * release context still masks a value that later completes it. */
	flushIdle(): string {
		return this.pending ? this.release("", false, true) : "";
	}

	get holding(): boolean {
		return this.pending.length > 0;
	}

	private release(text: string, end: boolean, idle = false): string {
		let buf = this.pending + text;
		if (this.discardToken) {
			buf = buf.slice(buf.match(this.discardToken)?.[0].length ?? 0);
			if (!buf && !end) {
				this.pending = "";
				return "";
			}
			this.discardToken = undefined;
		}
		// Discriminators of a human record can precede its credential in released output. Either
		// window is parsed from its recorded start state, never from wherever the cut fell.
		const wide = this.humanHeld || /secretkey|sealedkey|\\u/i.test(this.recent + buf);
		const context = wide ? this.historyStart.render() + this.history : this.recentStart.render() + this.recent;
		const all = context + buf;
		const base = context.length;
		const undecided: Undecided = { open: [] };
		const found = context || mayHoldIdentity(buf) ? identitySpans(all, undecided) : [];
		const tail = undecidedTail(all, 0);
		// An idle pause releases a public name or token prefix, never a human-record key awaiting its value.
		let hold = end || (idle && tail.value === undefined && !tail.keep) ? all.length : Math.max(base, tail.start);
		const open = undecided.open.filter((s) => s.start >= base);
		const firstOpen = Math.min(...open.map((s) => s.start));
		this.humanHeld = !end && open.length > 0 && all.length - firstOpen <= HOLD;
		if (this.humanHeld) hold = Math.min(hold, firstOpen);
		const masks: Span[] = [...found, ...open];
		if (end && tail.value !== undefined)
			masks.push({ start: tail.value, end: all.length, replacement: IDENTITY_MASK });
		const released = all.slice(base, hold);
		const out = splice(
			released,
			masks
				.filter((s) => s.end > base && s.start < hold)
				.map((s) => ({ ...s, start: Math.max(s.start, base) - base, end: Math.min(s.end, hold) - base })),
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
		this.history += released;
		if (this.history.length > HISTORY) {
			const cut = this.history.length - HISTORY;
			this.historyStart.feed(this.history.slice(0, cut));
			this.history = this.history.slice(cut);
		}
		this.recent += released;
		if (this.recent.length > RELEASE_CONTEXT) {
			const cut = this.recent.length - RELEASE_CONTEXT;
			this.recentStart.feed(this.recent.slice(0, cut));
			this.recent = this.recent.slice(cut);
		}
	}
}
