// Line and column of a syntax error for the parse-break warning (senpi#7234). A lone LF, a lone CR and a CRLF pair
// are one line break each; scripts also break lines at U+2028 and U+2029, as ECMAScript does, while JSON does not.
// Columns count UTF-16 code units, as JSON.parse offsets do. Worker-safe.

export interface TextPosition {
	readonly line: number;
	readonly column: number;
}

/** The 1-based line and column of `offset` in `content`. */
export function lineAndColumn(content: string, offset: number, scriptLineBreaks: boolean): TextPosition {
	let line = 1;
	let lineStart = 0;
	for (let index = 0; index < offset; index++) {
		const code = content.charCodeAt(index);
		const isBreak =
			code === 0x0a ||
			(code === 0x0d && content.charCodeAt(index + 1) !== 0x0a) ||
			(scriptLineBreaks && (code === 0x2028 || code === 0x2029));
		if (isBreak) {
			line++;
			lineStart = index + 1;
		}
	}
	return { line, column: offset - lineStart + 1 };
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * The UTF-16 index of a UTF-8 byte offset into `content`, or `undefined` when the offset falls inside a character or
 * past the end. A lone surrogate counts as U+FFFD, three bytes, as a UTF-8 encoder writes it.
 */
export function utf16IndexOfUtf8Offset(content: string, byteOffset: number): number | undefined {
	let bytes = 0;
	let index = 0;
	while (bytes < byteOffset && index < content.length) {
		const code = content.charCodeAt(index);
		const pair = code >= 0xd800 && code <= 0xdbff && isLowSurrogate(content.charCodeAt(index + 1));
		bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : pair ? 4 : 3;
		index += pair ? 2 : 1;
	}
	return bytes === byteOffset ? index : undefined;
}
