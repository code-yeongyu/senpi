export const IDENTITY_MASK = "[REDACTED]";
export const isPrivateField = (key: string): boolean => /^(?:signing|sealing)(?:_private_key|privatekey)?$/i.test(key);
export const isSecretBytes = (value: unknown): boolean => {
	if (typeof value === "string") {
		if (/^(?:[a-f\d]{64}|[a-f\d]{96})$/i.test(value)) return true;
		if (!/^(?:[a-z\d+/_-]{43}=?|[a-z\d+/_-]{64})$/i.test(value)) return false;
		const length = Buffer.from(value, "base64url").length;
		return length === 32 || length === 48;
	}
	return Array.isArray(value) && value.length === 32 && value.every((n) => Number.isInteger(n) && n >= 0 && n < 256);
};

export interface Span {
	start: number;
	end: number;
	replacement: string;
}
/** Human-record candidates whose object the visible text has not closed (`open`), or that
 * sit in no visible object at all (`orphan`). A stream holds the first and masks both
 * when it has to release them undecided. */
export interface Undecided {
	open: Span[];
	orphan: Span[];
}
interface ObjectScope {
	human: boolean;
	version: boolean;
	candidates: Span[];
}

const NAME = "(?:signing|sealing)(?:_private_key|privatekey)?";
const TOKEN = /tvk1:[a-z\d_=-]+|AGE-SECRET-KEY-1[a-z\d]+/gi;
// A JSON/Python key, YAML `name: value`, `name=value`, `export NAME="value"` or `name<TAB>value`.
const SEPARATOR = `["']?(?:\\s{0,64}[:=]|[ ]{0,64}\\t)\\s{0,64}["']?`;
const PRIVATE_VALUE = new RegExp(`(?<!\\w)${NAME}(${SEPARATOR})([a-z\\d+/_=-]+|\\[[\\d,\\s]{0,4096}\\])`, "gi");
const NESTED_DEPTH = 8;

/** One escape level of view per raw text: every backslash run collapses to the character it
 * escapes (`\uXXXX` decoded), so a name or value nested in any number of JSON strings, or a
 * key spelled with escapes, reads as plain text. `at[i]` is the raw offset of view char i. */
function normalize(text: string): { view: string; at?: Int32Array } {
	if (!text.includes("\\")) return { view: text };
	const at = new Int32Array(text.length + 1);
	const parts: string[] = [];
	let n = 0;
	for (let i = 0; i < text.length;) {
		const slash = text.indexOf("\\", i);
		const stop = slash < 0 ? text.length : slash;
		if (stop > i) {
			parts.push(text.slice(i, stop));
			for (let k = i; k < stop; k++) at[n++] = k;
		}
		if (slash < 0) break;
		let k = slash;
		while (text.charCodeAt(k) === 92) k++;
		let ch = "";
		i = k + 1;
		if (k >= text.length) i = text.length;
		else if (text[k] === "u" && /^[\da-f]{4}$/i.test(text.slice(k + 1, k + 5))) {
			ch = String.fromCharCode(Number.parseInt(text.slice(k + 1, k + 5), 16));
			i = k + 5;
		} else if (text[k] === "u") i = k + 1;
		else ch = "ntrbf".includes(text[k]) ? (text[k] === "t" ? "\t" : "\n") : text[k];
		if (ch) {
			parts.push(ch);
			at[n++] = slash;
		}
	}
	at[n] = text.length;
	return { view: parts.join(""), at: at.subarray(0, n + 1) };
}

function stringEnd(text: string, start: number): number {
	for (let i = start + 1; i < text.length; i++) {
		if (text[i] === "\\") i++;
		else if (text[i] === text[start]) return i;
	}
	return text.length;
}

const decodeString = (raw: string, quote: string): string => {
	if (quote !== '"' || !raw.includes("\\")) return raw;
	try {
		return JSON.parse(`"${raw}"`) as string;
	} catch {
		return raw;
	}
};

// Decode only a nested string, and keep the raw offset of each UTF-16 code unit.
// A replacement can then be mapped back without touching any other escape or byte.
function nestedSpans(text: string, start: number, end: number, depth: number, undecided?: Undecided): Span[] {
	const raw = text.slice(start, end);
	if (depth >= NESTED_DEPTH || !raw.includes("\\") || !raw.includes("{")) return [];
	let decoded = "";
	const offsets = [start];
	for (let i = start; i < end;) {
		if (text[i] === "\\") {
			const width = text[i + 1] === "u" ? 6 : 2;
			try {
				decoded += JSON.parse(`"${text.slice(i, i + width)}"`);
			} catch {
				// An unterminated string may stop inside its last escape; decide what precedes it.
				if (i + width >= end) break;
				return [];
			}
			i += width;
		} else decoded += text[i++];
		offsets.push(i);
	}
	const inner: Undecided | undefined = undecided && { open: [], orphan: [] };
	const map = (s: Span): Span => ({
		start: offsets[s.start],
		end: offsets[s.end] ?? end,
		replacement: JSON.stringify(s.replacement).slice(1, -1),
	});
	const found = spans(decoded, depth + 1, inner).map(map);
	if (inner && undecided) undecided.open.push(...inner.open.map(map));
	return found;
}

/** The human-record rule: secretKey/sealedKey strings of an object whose kind is "human" and v is 1. */
function spans(text: string, depth: number, undecided?: Undecided): Span[] {
	const found: Span[] = [];
	const stack: ObjectScope[] = [];
	const finish = () => {
		const scope = stack.pop();
		if (scope?.human && scope.version) found.push(...scope.candidates);
	};
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === "{") {
			stack.push({ human: false, version: false, candidates: [] });
			continue;
		}
		if (c === "}") {
			finish();
			continue;
		}
		if (c !== '"' && c !== "'") continue;
		// An apostrophe in a diagnostic prefix is not a string literal.
		if (c === "'" && i > 0 && /[\w]/.test(text.charAt(i - 1))) continue;
		const end = stringEnd(text, i);
		const field = decodeString(text.slice(i + 1, end), c);
		found.push(...nestedSpans(text, i + 1, end, depth, end === text.length ? undecided : undefined));
		i = end;
		let v = end + 1;
		while (/\s/.test(text.charAt(v)) && v < text.length) v++;
		if (text[v] !== ":") continue;
		do {
			v++;
		} while (v < text.length && /\s/.test(text.charAt(v)));
		const scope = stack.at(-1);
		if (field === "v" && scope) scope.version = text[v] === "1" && !/[\d.eE]/.test(text.charAt(v + 1));
		if (text[v] === '"' || text[v] === "'") {
			const close = stringEnd(text, v);
			const span = { start: v + 1, end: close, replacement: IDENTITY_MASK };
			if (scope && field === "kind") scope.human = decodeString(text.slice(v + 1, close), text[v]) === "human";
			if (field === "secretKey" || field === "sealedKey") {
				if (scope) scope.candidates.push(span);
				else undecided?.orphan.push(span);
			}
			found.push(...nestedSpans(text, v + 1, close, depth, close === text.length ? undecided : undefined));
			i = close;
		}
	}
	if (undecided) for (const scope of stack) undecided.open.push(...scope.candidates);
	else while (stack.length) finish();
	return found;
}

/** Every masked span of `text`; with `undecided`, unclosed human-record candidates are
 * reported there instead of being dropped. */
export function identitySpans(text: string, undecided?: Undecided): Span[] {
	const { view, at } = normalize(text);
	const raw = (v: number) => (at ? at[v] : v);
	const found: Span[] = [];
	for (const m of view.matchAll(TOKEN))
		found.push({ start: raw(m.index), end: raw(m.index + m[0].length), replacement: IDENTITY_MASK });
	for (const m of view.matchAll(PRIVATE_VALUE)) {
		const [whole, separator, value] = m;
		const start = m.index + whole.length - value.length;
		let replacement = IDENTITY_MASK;
		if (value.startsWith("[")) {
			try {
				if (!isSecretBytes(JSON.parse(value))) continue;
			} catch {
				continue;
			}
			// Keep the replacement a string at the escape depth of the key's own quote.
			const escape = /^(\\*)["']/.exec(text.slice(raw(start - separator.length), raw(start)))?.[1] ?? "";
			replacement = `${escape}"${IDENTITY_MASK}${escape}"`;
		} else if (!isSecretBytes(value)) continue;
		found.push({ start: raw(start), end: raw(start + value.length), replacement });
	}
	found.push(...spans(text, 0, undecided));
	return found;
}

const MAY_MATCH = /tvk1:|age-secret-key-1|signing|sealing|secretkey|sealedkey|\\u/i;
export const mayHoldIdentity = (text: string): boolean => MAY_MATCH.test(text);

export function redactIdentityText(text: string): string {
	if (!MAY_MATCH.test(text)) return text;
	return splice(text, identitySpans(text));
}

export function splice(text: string, changes: Span[]): string {
	changes.sort((a, b) => a.start - b.start || b.end - a.end);
	if (!changes.length) return text;
	let out = "",
		offset = 0;
	for (const { start, end, replacement } of changes) {
		if (start < offset) continue;
		out += text.slice(offset, start) + replacement;
		offset = end;
	}
	return out + text.slice(offset);
}

const TAIL = 1024;
const NAMES = [
	"signing",
	"sealing",
	"signing_private_key",
	"sealing_private_key",
	"signingprivatekey",
	"sealingprivatekey",
];
const PRIVATE_TAIL = new RegExp(
	`(?<!\\w)${NAME}(["']?\\s{0,64}[:=\\t]?\\s{0,64}["']?)([a-z\\d+/_=-]{1,128}|\\[[\\d,\\s]{0,1024})?$`,
	"i",
);
const TOKEN_TAIL = /(?:tvk1:[a-z\d_=-]|age-secret-key-1[a-z\d])[a-z\d_=-]*$/i;

/** Where the undecided tail of `text` starts: a partial escape, a token prefix, a private
 * name with its separator and an unterminated value, or a partial human-record key. `value`
 * is the start of an unterminated private value, which an ending stream masks. */
export function undecidedTail(text: string, floor: number): { start: number; value?: number } {
	let from = Math.max(floor, text.length - TAIL);
	while (from > floor && text.charCodeAt(from - 1) === 92) from--;
	const tail = text.slice(from);
	const { view, at } = normalize(tail);
	const raw = (v: number) => from + (at ? at[v] : v);
	let start = text.length;
	let value: number | undefined;
	const escape = /\\+(?:u[\da-f]{0,4})?$/i.exec(tail);
	if (escape) start = from + escape.index;
	// A token already past its prefix is masked now; the stream discards the rest of its body.
	if (!escape && TOKEN_TAIL.test(view)) return { start };
	const lower = view.slice(-24).toLowerCase();
	for (let i = 0; i < lower.length; i++) {
		const rest = lower.slice(i);
		const boundary = !/\w/.test(view.charAt(view.length - rest.length - 1));
		const token = ["tvk1:", "age-secret-key-1"].some((p) => p.startsWith(rest));
		if (boundary && (token || NAMES.some((p) => p.startsWith(rest)))) {
			start = Math.min(start, raw(view.length - rest.length));
			break;
		}
	}
	const field = PRIVATE_TAIL.exec(view);
	if (field) {
		start = Math.min(start, raw(field.index));
		if (/[:=\t]/.test(field[1] ?? "") && field[2]) value = raw(view.length - field[2].length);
	}
	const key = /["']([a-z]{0,9})(?:["']\s*(?::\s*)?)?$/i.exec(view);
	if (key && ["secretKey", "sealedKey"].some((k) => k.startsWith(key[1]))) start = Math.min(start, raw(key.index));
	return { start, value };
}
