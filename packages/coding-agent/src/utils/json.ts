/** Strip `//` line comments and trailing commas from JSON, leaving string literals untouched. */
export function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

function firstJsonSyntaxErrorOffset(text: string): number {
	const stringToken = /"(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
	const literalToken = /true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
	let offset = 0;
	const skipWhitespace = () => {
		while (/[ \t\n\r]/.test(text[offset] ?? "")) offset++;
	};
	const token = (pattern: RegExp): boolean => {
		pattern.lastIndex = offset;
		const match = pattern.exec(text);
		if (match) offset += match[0].length;
		return match !== null;
	};
	const take = (char: string): boolean => {
		skipWhitespace();
		if (text[offset] !== char) return false;
		offset++;
		return true;
	};
	const members = (close: string, member: () => boolean): boolean => {
		if (take(close)) return true;
		do {
			if (!member()) return false;
		} while (take(","));
		return take(close);
	};
	const property = (): boolean => {
		skipWhitespace();
		return token(stringToken) && take(":") && value();
	};
	const value = (): boolean => {
		skipWhitespace();
		if (take("{")) return members("}", property);
		if (take("[")) return members("]", value);
		return token(stringToken) || token(literalToken);
	};
	if (value()) skipWhitespace();
	return offset;
}

/**
 * "line L, column C" (1-based) of the first character strict JSON rejects in `text`. Bun's
 * `JSON.parse` errors carry no position, so a config parse error points the user at it this way.
 */
export function jsonSyntaxErrorPosition(text: string): string {
	const offset = firstJsonSyntaxErrorOffset(text);
	const before = text.slice(0, offset);
	return `line ${before.split("\n").length}, column ${offset - before.lastIndexOf("\n")}`;
}
