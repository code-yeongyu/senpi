import {
	IDENTITY_MASK,
	identitySpans,
	MAX_GAP,
	mayHoldIdentity,
	type Span,
	splice,
	stringEnd,
	type Undecided,
} from "./identity-text.ts";
import { undecidedTail } from "./identity-tail.ts";

const closers = (text: string): number => {
	let n = 0;
	for (let i = text.indexOf("}"); i >= 0; i = text.indexOf("}", i + 1)) n++;
	return n;
};
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
	// The rest of a value already masked at the end of a release, still arriving.
	private discard: { token: RegExp } | { quote: string; escaped: boolean } | undefined;
	// A secret key the parser could not place was released: mask the value that follows it.
	private awaiting: "colon" | "value" | undefined;

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
		if (this.discard) {
			buf = buf.slice(this.skipDiscarded(buf));
			if (!buf && !end) {
				this.pending = "";
				return "";
			}
			this.discard = undefined;
		}
		// Discriminators of a human record can precede its credential in released output. Either
		// window is parsed from its recorded start state, never from wherever the cut fell.
		const wide = this.humanHeld || /secretkey|sealedkey|\\u/i.test(this.recent + buf);
		const [start, window] = wide ? [this.historyStart, this.history] : [this.recentStart, this.recent];
		const context = start.render(closers(window + buf) + 1) + window;
		const all = context + buf;
		const base = context.length;
		const undecided: Undecided = { open: [] };
		const found = context || mayHoldIdentity(buf) ? identitySpans(all, undecided) : [];
		found.push(...this.valueAfterDoubtfulKey(buf, base));
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
		// A masked token or value that runs to the end of the released text continues in the next chunk.
		const running = found.find((s) => s.end === all.length && s.replacement === IDENTITY_MASK);
		if (!end && hold === all.length && running) {
			const body = all.slice(running.start);
			if (running.until) this.discard = { quote: running.until, escaped: /(?:^|[^\\])(?:\\\\)*\\$/.test(body) };
			else if (/^(?:tvk1:|age-)/i.test(all.slice(running.start, running.start + 5)))
				this.discard = { token: /^tvk1:/i.test(body) ? /^[a-z\d_=-]*/i : /^[a-z\d]*/i };
		}
		if (hold === all.length && undecided.awaiting) this.awaiting = undecided.awaiting;
		this.pending = all.slice(hold);
		this.remember(released);
		return out;
	}

	/** Length of the leading part of `buf` that continues a value already masked. */
	private skipDiscarded(buf: string): number {
		const discard = this.discard;
		if (!discard) return 0;
		if ("token" in discard) return buf.match(discard.token)?.[0].length ?? 0;
		for (let i = 0; i < buf.length; i++) {
			const c = buf[i];
			if (discard.escaped) discard.escaped = false;
			else if (c === "\\") discard.escaped = true;
			else if (c === discard.quote || c === "\n" || c === "\r") return i;
		}
		return buf.length;
	}

	/** Fail-safe for a secret key the record parser could not place: the first value after it
	 * is masked, across any gap and any number of releases. */
	private valueAfterDoubtfulKey(buf: string, base: number): Span[] {
		if (!this.awaiting) return [];
		let i = 0;
		for (; i < buf.length; i++) {
			const c = buf[i];
			if (this.awaiting === "colon" && c === ":") this.awaiting = "value";
			else if (!/\s/.test(c)) break;
		}
		if (i === buf.length) return [];
		const quote = buf[i];
		const value = this.awaiting === "value" && (quote === '"' || quote === "'");
		this.awaiting = undefined;
		if (!value) return [];
		return [{ start: base + i + 1, end: base + stringEnd(buf, i), replacement: IDENTITY_MASK, until: quote }];
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
