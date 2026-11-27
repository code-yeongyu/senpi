import { decodeString } from "./identity-text.ts";

const KEPT_NAMES = new Set(["kind", "v", "secretKey", "sealedKey"]);
const KEPT_RAW = 64;

interface Scope {
	human: boolean;
	version: boolean;
}

/** Lexical state of released output, advanced character by character with the same rules the
 * record parser in identity-text.ts applies (strings, escapes, the apostrophe rule, keys, objects).
 * A stream's context window starts at an arbitrary character; render() rebuilds the open objects,
 * their discriminators and any unfinished string or key as text, so the window is parsed from the
 * true state instead of from a cut. */
export class ScopeState {
	private stack: Scope[] = [];
	private quote = "";
	private escaped = false;
	private raw = "";
	private overflow = false;
	private field: string | undefined;
	private pendingKey: string | undefined;
	private afterColon: string | undefined;
	private versionDigit = false;
	private previous = "";

	feed(text: string): void {
		for (const c of text) this.step(c);
	}

	private step(c: string): void {
		if (this.quote) {
			if (this.escaped) this.escaped = false;
			else if (c === "\\") this.escaped = true;
			else if (c === this.quote || c === "\n" || c === "\r") return this.closeString(c);
			if (this.raw.length < KEPT_RAW) this.raw += c;
			else this.overflow = true;
			return;
		}
		const top = this.stack.at(-1);
		if (this.versionDigit) {
			this.versionDigit = false;
			if (top) top.version = !/[\d.eE]/.test(c);
		}
		if (this.afterColon !== undefined) {
			if (/\s/.test(c)) return;
			const field = this.afterColon;
			this.afterColon = undefined;
			if (field === "v" && top) {
				top.version = false;
				if (c === "1") this.versionDigit = true;
			}
			if (c === '"' || c === "'") return this.openString(c, field);
		}
		if (this.pendingKey !== undefined) {
			if (/\s/.test(c)) return;
			if (c === ":") {
				this.afterColon = this.pendingKey;
				this.pendingKey = undefined;
				return;
			}
			this.pendingKey = undefined;
		}
		if (c === "{") this.stack.push({ human: false, version: false });
		else if (c === "}") this.stack.pop();
		else if ((c === '"' || c === "'") && !(c === "'" && /\w/.test(this.previous))) return this.openString(c);
		this.previous = c;
	}

	private openString(quote: string, field?: string): void {
		this.quote = quote;
		this.field = field;
		this.raw = "";
		this.overflow = false;
	}

	private closeString(closer: string): void {
		const value = this.overflow ? undefined : decodeString(this.raw, this.quote);
		const top = this.stack.at(-1);
		if (this.field === undefined) this.pendingKey = value ?? "_";
		else if (this.field === "kind" && top) top.human = value === "human";
		this.previous = closer;
		this.quote = "";
		this.field = undefined;
	}

	/** Text that leaves the record parser in this state. Only the innermost `depth` objects are
	 * written: a window that closes fewer braces than that cannot reach the outer ones. */
	render(depth: number): string {
		const name = (key: string) => (KEPT_NAMES.has(key) ? key : "_");
		let out = this.stack
			.slice(-depth)
			.map((s) => `{${s.version ? '"v":1,' : ""}${s.human ? '"kind":"human",' : ""}`)
			.join("");
		if (this.quote) {
			const kept = this.overflow ? "" : this.raw;
			if (this.field === undefined) out += this.quote + kept;
			else out += `"${name(this.field)}":${this.quote}${this.field === "kind" ? kept : ""}`;
			if (this.escaped && !kept.endsWith("\\")) out += "\\";
		} else if (this.versionDigit) out += '"v":1';
		else if (this.afterColon !== undefined) out += `"${name(this.afterColon)}":`;
		else if (this.pendingKey !== undefined) out += `"${name(this.pendingKey)}"`;
		else if (/\w/.test(this.previous)) out += "_";
		return out;
	}
}
