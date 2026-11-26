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

interface Span {
	start: number;
	end: number;
	replacement: string;
}
interface ObjectScope {
	human: boolean;
	version: boolean;
	candidates: Span[];
}

function stringEnd(text: string, start: number): number {
	for (let i = start + 1; i < text.length; i++) {
		if (text[i] === "\\") i++;
		else if (text[i] === text[start]) return i;
	}
	return text.length;
}

// Decode only a nested string, and keep the raw offset of each UTF-16 code unit.
// A replacement can then be mapped back without touching any other escape or byte.
function nestedSpans(text: string, start: number, end: number, depth: number): Span[] {
	const raw = text.slice(start, end);
	if (depth >= 4 || !raw.includes("\\") || !/[{\\]/.test(raw)) return [];
	let decoded = "";
	const offsets = [start];
	for (let i = start; i < end;) {
		if (text[i] === "\\") {
			const width = text[i + 1] === "u" ? 6 : 2;
			try {
				decoded += JSON.parse(`"${text.slice(i, i + width)}"`);
			} catch {
				return [];
			}
			i += width;
		} else decoded += text[i++];
		offsets.push(i);
	}
	return spans(decoded, depth + 1).map((s) => ({
		start: offsets[s.start],
		end: offsets[s.end],
		replacement: JSON.stringify(s.replacement).slice(1, -1),
	}));
}

function spans(text: string, depth: number, open?: ObjectScope[]): Span[] {
	const found: Span[] = [];
	const stack: ObjectScope[] = [];
	const finish = () => {
		const scope = stack.pop();
		if (scope?.human && scope.version) found.push(...scope.candidates);
	};
	for (const m of text.matchAll(/tvk1:[a-z\d_=-]+|AGE-SECRET-KEY-1[a-z\d]+/gi))
		found.push({ start: m.index, end: m.index + m[0].length, replacement: IDENTITY_MASK });
	for (const m of text.matchAll(/\b((?:signing|sealing)(?:_private_key|privatekey)?)\s*=\s*([a-z\d+/_=-]+)/gi)) {
		if (isSecretBytes(m[2]))
			found.push({
				start: m.index + m[0].length - m[2].length,
				end: m.index + m[0].length,
				replacement: IDENTITY_MASK,
			});
	}
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
		const field = text.slice(i + 1, end);
		found.push(...nestedSpans(text, i + 1, end, depth));
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
			const value = text.slice(v + 1, close);
			const span = { start: v + 1, end: close, replacement: IDENTITY_MASK };
			if (isPrivateField(field) && isSecretBytes(value)) found.push(span);
			if (scope && field === "kind") scope.human = value === "human";
			if (field === "secretKey" || field === "sealedKey") scope?.candidates.push(span);
			found.push(...nestedSpans(text, v + 1, close, depth));
			i = close;
		} else if (isPrivateField(field) && text[v] === "[") {
			const close = text.indexOf("]", v + 1);
			if (close !== -1 && close - v <= 4096) {
				try {
					if (isSecretBytes(JSON.parse(text.slice(v, close + 1))))
						found.push({ start: v, end: close + 1, replacement: JSON.stringify(IDENTITY_MASK) });
				} catch {
					/* Not a JSON byte array. */
				}
			}
		}
	}
	if (open) open.push(...stack);
	else while (stack.length) finish();
	return found;
}

export function redactIdentityText(text: string): string {
	if (!/tvk1:|age-secret-key-1|signing|sealing|secretkey|sealedkey|\\u/i.test(text)) return text;
	return splice(text, spans(text, 0));
}

function splice(text: string, changes: Span[]): string {
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

/** Cut only at a completed member/subobject. A later discriminator can still decide
 * an earlier human credential, so never publish that unresolved prefix. */
export function redactCompletePrefix(text: string): { output: string; context: string } | undefined {
	const open: ObjectScope[] = [];
	const found = spans(text, 0, open);
	if (open.some((s) => s.candidates.length > 0)) return undefined;
	const context = open.map((s) => "{" + (s.version ? '"v":1,' : "") + (s.human ? '"kind":"human",' : "")).join("");
	return { output: splice(text, found), context };
}
