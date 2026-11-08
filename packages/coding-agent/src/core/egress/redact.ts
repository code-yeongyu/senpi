export const REDACTED = "<redacted>";

const MIN_FRAGMENT = 8;

export interface RedactorOptions {
	readonly secrets: readonly string[];
	readonly publicPrefixes: readonly string[];
}

export interface Redactor {
	redact(text: string): string;
}

interface Pattern {
	readonly text: string;
	readonly wholeToken: boolean;
}

interface AutomatonNode {
	readonly next: Map<string, number>;
	fail: number;
	readonly outputs: number[];
}

function isTokenChar(char: string | undefined): boolean {
	return char !== undefined && /[A-Za-z0-9]/.test(char);
}

/**
 * Base64 characters that depend only on the secret's bytes when the secret starts `offset` bytes into a longer
 * stream: character i covers bits [6i, 6i + 6), and it is kept only when that range lies inside the secret's bits.
 */
function alignedBase64Core(secret: Uint8Array, offset: number, alphabet: "base64" | "base64url"): string {
	const encoded = Buffer.concat([Buffer.alloc(offset), secret])
		.toString(alphabet)
		.replace(/=+$/, "");
	const firstBit = offset * 8;
	const lastBit = firstBit + secret.length * 8;
	let core = "";
	for (let i = 0; i < encoded.length; i++) {
		if (i * 6 >= firstBit && i * 6 + 6 <= lastBit) core += encoded[i];
	}
	return core;
}

function patternsFor(secret: string, publicPrefixes: readonly string[]): Pattern[] {
	const bytes = Buffer.from(secret, "utf8");
	const patterns: Pattern[] = [{ text: secret, wholeToken: true }];
	const urlEncoded = encodeURIComponent(secret);
	if (urlEncoded !== secret) patterns.push({ text: urlEncoded, wholeToken: true });
	for (const alphabet of ["base64", "base64url"] as const) {
		patterns.push({ text: bytes.toString(alphabet), wholeToken: true });
		for (const offset of [0, 1, 2]) {
			const core = alignedBase64Core(bytes, offset, alphabet);
			if (core.length >= MIN_FRAGMENT) patterns.push({ text: core, wholeToken: false });
		}
	}
	for (let i = 0; i + MIN_FRAGMENT <= secret.length; i++) {
		const gram = secret.slice(i, i + MIN_FRAGMENT);
		if (!publicPrefixes.some((prefix) => prefix.includes(gram))) patterns.push({ text: gram, wholeToken: false });
	}
	return patterns;
}

function buildAutomaton(patterns: readonly Pattern[]): AutomatonNode[] {
	const nodes: AutomatonNode[] = [{ next: new Map(), fail: 0, outputs: [] }];
	patterns.forEach((pattern, index) => {
		let state = 0;
		for (const char of pattern.text) {
			let target = nodes[state].next.get(char);
			if (target === undefined) {
				target = nodes.length;
				nodes.push({ next: new Map(), fail: 0, outputs: [] });
				nodes[state].next.set(char, target);
			}
			state = target;
		}
		nodes[state].outputs.push(index);
	});
	const queue: number[] = [...nodes[0].next.values()];
	for (let head = 0; head < queue.length; head++) {
		const state = queue[head];
		for (const [char, target] of nodes[state].next) {
			let fallback = nodes[state].fail;
			while (fallback !== 0 && !nodes[fallback].next.has(char)) fallback = nodes[fallback].fail;
			const candidate = nodes[fallback].next.get(char);
			nodes[target].fail = candidate !== undefined && candidate !== target ? candidate : 0;
			nodes[target].outputs.push(...nodes[nodes[target].fail].outputs);
			queue.push(target);
		}
	}
	return nodes;
}

export function createRedactor(options: RedactorOptions): Redactor {
	const patterns = options.secrets
		.filter((secret) => secret.length > 0)
		.flatMap((secret) => patternsFor(secret, options.publicPrefixes));
	if (patterns.length === 0) return { redact: (text) => text };
	const nodes = buildAutomaton(patterns);

	return {
		redact(text: string): string {
			const chars = [...text];
			const spans: Array<[number, number]> = [];
			let state = 0;
			for (let end = 0; end < chars.length; end++) {
				const char = chars[end];
				while (state !== 0 && !nodes[state].next.has(char)) state = nodes[state].fail;
				state = nodes[state].next.get(char) ?? 0;
				for (const index of nodes[state].outputs) {
					const pattern = patterns[index];
					const start = end - [...pattern.text].length + 1;
					if (pattern.wholeToken && (isTokenChar(chars[start - 1]) || isTokenChar(chars[end + 1]))) continue;
					spans.push([start, end + 1]);
				}
			}
			if (spans.length === 0) return text;
			spans.sort((a, b) => a[0] - b[0]);
			let out = "";
			let cursor = 0;
			let current = spans[0];
			for (const span of spans.slice(1)) {
				if (span[0] <= current[1]) {
					current = [current[0], Math.max(current[1], span[1])];
					continue;
				}
				out += chars.slice(cursor, current[0]).join("") + REDACTED;
				cursor = current[1];
				current = span;
			}
			out += chars.slice(cursor, current[0]).join("") + REDACTED + chars.slice(current[1]).join("");
			return out;
		},
	};
}
