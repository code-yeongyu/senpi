/**
 * Decodes one JSON string literal straight from its UTF-8 bytes (senpi#3968). A paged session body is read back by its
 * byte range; decoding it with `JSON.parse(bytes.toString())` builds the escaped text first and the value second, so a
 * full read of a large session briefly held every body twice. This writes the unescaped UTF-8 into a reusable buffer and
 * builds the string once. Anything it does not recognise returns undefined, and the caller falls back to JSON.parse.
 */

const QUOTE = 0x22;
const BACKSLASH = 0x5c;

const SIMPLE_ESCAPES: Readonly<Record<number, number>> = {
	0x22: 0x22, // \"
	0x5c: 0x5c, // \\
	0x2f: 0x2f, // \/
	0x62: 0x08, // \b
	0x66: 0x0c, // \f
	0x6e: 0x0a, // \n
	0x72: 0x0d, // \r
	0x74: 0x09, // \t
};

const hex4 = (bytes: Buffer, at: number): number => {
	if (at + 4 > bytes.length) return -1;
	let value = 0;
	for (let index = at; index < at + 4; index++) {
		const code = bytes[index] ?? 0;
		const digit =
			code >= 0x30 && code <= 0x39
				? code - 0x30
				: code >= 0x61 && code <= 0x66
					? code - 0x57
					: code >= 0x41 && code <= 0x46
						? code - 0x37
						: -1;
		if (digit < 0) return -1;
		value = value * 16 + digit;
	}
	return value;
};

const writeUtf8 = (out: Buffer, at: number, codePoint: number): number => {
	if (codePoint < 0x80) {
		out[at] = codePoint;
		return at + 1;
	}
	if (codePoint < 0x800) {
		out[at] = 0xc0 | (codePoint >> 6);
		out[at + 1] = 0x80 | (codePoint & 0x3f);
		return at + 2;
	}
	if (codePoint < 0x10000) {
		out[at] = 0xe0 | (codePoint >> 12);
		out[at + 1] = 0x80 | ((codePoint >> 6) & 0x3f);
		out[at + 2] = 0x80 | (codePoint & 0x3f);
		return at + 3;
	}
	out[at] = 0xf0 | (codePoint >> 18);
	out[at + 1] = 0x80 | ((codePoint >> 12) & 0x3f);
	out[at + 2] = 0x80 | ((codePoint >> 6) & 0x3f);
	out[at + 3] = 0x80 | (codePoint & 0x3f);
	return at + 4;
};

/**
 * `bytes` must be exactly one JSON string literal, quotes included. `scratch` receives the decoded UTF-8 and must be at
 * least `bytes.length` long (unescaping never grows the text). Returns the string, or undefined when the literal is not
 * one this decoder is sure about (unpaired surrogate escapes, control characters, a malformed escape).
 */
export function decodeJsonStringBytes(bytes: Buffer, scratch: Buffer): string | undefined {
	const last = bytes.length - 1;
	if (last < 1 || bytes[0] !== QUOTE || bytes[last] !== QUOTE || scratch.length < bytes.length) return undefined;
	let write = 0;
	let read = 1;
	while (read < last) {
		const byte = bytes[read] ?? 0;
		if (byte === QUOTE || byte < 0x20) return undefined;
		if (byte !== BACKSLASH) {
			scratch[write++] = byte;
			read++;
			continue;
		}
		const escape = bytes[read + 1] ?? 0;
		const simple = SIMPLE_ESCAPES[escape];
		if (simple !== undefined) {
			scratch[write++] = simple;
			read += 2;
			continue;
		}
		if (escape !== 0x75) return undefined;
		let codePoint = hex4(bytes, read + 2);
		if (codePoint < 0) return undefined;
		read += 6;
		if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
			const low = bytes[read] === BACKSLASH && bytes[read + 1] === 0x75 ? hex4(bytes, read + 2) : -1;
			if (low < 0xdc00 || low > 0xdfff) return undefined;
			codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
			read += 6;
		} else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
			return undefined;
		}
		write = writeUtf8(scratch, write, codePoint);
	}
	return read === last ? scratch.toString("utf8", 0, write) : undefined;
}
