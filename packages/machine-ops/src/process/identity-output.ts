import { IDENTITY_MASK, redactCompletePrefix, redactIdentityText } from "./identity-text.ts";

const prefixes = [
	"tvk1:",
	"age-secret-key-1",
	"signing",
	"sealing",
	"signing_private_key",
	"sealing_private_key",
	"signingprivatekey",
	"sealingprivatekey",
];

/** Hold undecided input, never retroactively redact bytes already published. A different
 * instance owns each fd/PTY. latin1 maps every byte to one code unit, even for non-UTF8 PTYs. */
export class IdentityOutputStream {
	private plainTail = "";
	private record: string[] = [];
	private recordSize = 0;
	private depth = 0;
	private quote = "";
	private escaped = false;
	private oversized = false;
	private context = "";
	private brackets = 0;
	private nextCut = 65536;
	private discardToken: RegExp | undefined;

	private plain(text: string, boundary: boolean): string {
		let value = this.plainTail + text;
		this.plainTail = "";
		if (this.discardToken) {
			const n = value.match(this.discardToken)?.[0].length ?? 0;
			value = value.slice(n);
			if (!value && !boundary) return "";
			this.discardToken = undefined;
		}
		if (!boundary) {
			const token = /(?:tvk1:[a-z\d_=-]*|age-secret-key-1[a-z\d]*)$/i.exec(value);
			if (token) {
				this.discardToken = /^tvk1:/i.test(token[0]) ? /^[a-z\d_=-]*/i : /^[a-z\d]*/i;
				return redactIdentityText(value.slice(0, token.index)) + IDENTITY_MASK;
			}
			const assignment = /\b(?:signing|sealing)(?:_private_key|privatekey)?\s*(?:=\s*[a-z\d+/_=-]{0,96})?$/i.exec(
				value,
			);
			if (assignment) {
				this.plainTail = assignment[0];
				value = value.slice(0, assignment.index);
			} else {
				const suffix = value.slice(-24).toLowerCase();
				for (let i = 0; i < suffix.length; i++) {
					if (prefixes.some((p) => p.startsWith(suffix.slice(i)))) {
						this.plainTail = value.slice(i - suffix.length);
						value = value.slice(0, i - suffix.length);
						break;
					}
				}
			}
		}
		return redactIdentityText(value);
	}

	private append(part: string): string {
		this.recordSize += part.length;
		if (!this.oversized && part) this.record.push(part);
		if (!this.oversized && this.quote && this.recordSize >= this.nextCut) {
			const buffered = this.context + this.record.join("");
			// An ordinary long scalar cannot match a length-constrained device field.
			// Keep an undecided prefix/token or escaped nested record, and never cut
			// across a human credential whose sibling discriminators are still pending.
			let quote = "",
				open = 0;
			for (let i = 0; i < buffered.length; i++) {
				const c = buffered[i];
				if (quote) {
					if (c === "\\") i++;
					else if (c === quote) quote = "";
				} else if (c === '"' || c === "'") {
					quote = c;
					open = i;
				}
			}
			let cut = buffered.length - 128;
			const boundary = buffered.slice(Math.max(open + 1, cut - 24), cut).toLowerCase();
			for (let i = 0; i < boundary.length; i++) {
				if (prefixes.some((p) => p.startsWith(boundary.slice(i)))) {
					cut -= boundary.length - i;
					break;
				}
			}
			if (cut > 0 && /[\uD800-\uDBFF]/.test(buffered.charAt(cut - 1))) cut--;
			const scalar = buffered.slice(open + 1, cut);
			if (
				quote &&
				cut > this.context.length &&
				scalar.length > 96 &&
				!/[\\{}]|tvk1:|age-secret-key-1|signing|sealing|secretkey|sealedkey/i.test(scalar)
			) {
				const partial = redactCompletePrefix(buffered.slice(0, cut));
				if (partial) {
					const output = partial.output.slice(this.context.length);
					this.context = partial.context + '"_":' + quote;
					this.record = [buffered.slice(cut)];
					this.recordSize = this.record[0].length;
					this.nextCut = 65536;
					return output;
				}
			}
			this.nextCut *= 2;
		}
		if (this.depth && this.recordSize > 4 * 1024 * 1024) {
			this.oversized = true;
			this.record.length = 0;
		}
		return "";
	}

	private seal(): string {
		const out = this.oversized
			? "[identity filter: oversized unverified record withheld]"
			: redactIdentityText(this.context + this.record.join("")).slice(this.context.length);
		this.depth = 0;
		this.quote = "";
		this.escaped = false;
		this.record.length = 0;
		this.recordSize = 0;
		this.oversized = false;
		this.context = "";
		this.brackets = 0;
		this.nextCut = 65536;
		return out;
	}

	push(text: string): string {
		let out = "",
			start = 0;
		for (let i = 0; i < text.length; i++) {
			if (!this.depth) {
				const open = text.indexOf("{", i);
				if (open < 0) return out + this.plain(text.slice(start), false);
				out += this.plain(text.slice(start, open), true);
				start = open;
				i = open;
				this.depth = 1;
				continue;
			}
			const c = text[i];
			if (this.quote) {
				if (this.escaped) this.escaped = false;
				else if (c === "\\") this.escaped = true;
				else if (c === this.quote) this.quote = "";
			} else if (c === '"' || c === "'") this.quote = c;
			else {
				if (c === "{") this.depth++;
				else if (c === "[") this.brackets++;
				else if (c === "]") this.brackets = Math.max(0, this.brackets - 1);
				else if (c === "}" && --this.depth === 0) {
					out += this.append(text.slice(start, i + 1));
					out += this.seal();
					start = i + 1;
					continue;
				}
				if (
					!this.oversized &&
					(c === "}" || (c === "," && !this.brackets)) &&
					this.recordSize + i + 1 - start >= this.nextCut
				) {
					out += this.append(text.slice(start, i + 1));
					start = i + 1;
					const part = redactCompletePrefix(this.context + this.record.join(""));
					if (part && !this.oversized) {
						out += part.output.slice(this.context.length);
						this.context = part.context;
						this.record = [];
						this.recordSize = 0;
						this.nextCut = 65536;
					} else this.nextCut *= 2;
				}
			}
		}
		if (this.depth) out += this.append(text.slice(start));
		return out;
	}

	pushBytes(bytes: Uint8Array): Buffer {
		return Buffer.from(
			this.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1")),
			"latin1",
		);
	}

	finish(): string {
		if (!this.depth) return this.plain("", true);
		// If the producer exited mid-value, the final bytes cannot establish its
		// encoded length. Do not publish a fragment of an unverified secret.
		if (this.quote && /signing|sealing|secretkey|sealedkey/i.test(this.record.join(""))) {
			this.seal();
			return "[identity filter: incomplete record withheld]";
		}
		return this.seal();
	}
}
