function skipTrivia(source: string, index: number): { readonly index: number; readonly hasLineTerminator: boolean } {
	let hasLineTerminator = false;
	while (index < source.length) {
		const char = source[index];
		if (char === "\r" || char === "\n" || char === "\u2028" || char === "\u2029") {
			hasLineTerminator = true;
			index += 1;
			continue;
		}
		if (char !== undefined && /\s/u.test(char)) {
			index += 1;
			continue;
		}
		if (char === "/" && source[index + 1] === "/") {
			index += 2;
			while (index < source.length && !/[\r\n\u2028\u2029]/u.test(source[index] ?? "")) index += 1;
			continue;
		}
		if (char === "/" && source[index + 1] === "*") {
			index += 2;
			while (index < source.length) {
				const commentChar = source[index];
				if (commentChar === "\r" || commentChar === "\n" || commentChar === "\u2028" || commentChar === "\u2029")
					hasLineTerminator = true;
				if (commentChar === "*" && source[index + 1] === "/") {
					index += 2;
					break;
				}
				index += 1;
			}
			continue;
		}
		break;
	}
	return { index, hasLineTerminator };
}

function stringLiteralEnd(source: string, index: number): number | undefined {
	const quote = source[index];
	if (quote !== '"' && quote !== "'") return undefined;
	for (index += 1; index < source.length; index += 1) {
		const char = source[index];
		if (char === "\\") {
			index += 1;
			if (source[index] === "\r" && source[index + 1] === "\n") index += 1;
			continue;
		}
		if (char === quote) return index + 1;
		if (char === "\r" || char === "\n") return undefined;
	}
	return undefined;
}

function isStringExpressionContinuation(source: string, index: number): boolean {
	const char = source[index];
	if (char === undefined) return false;
	if (char === "+" || char === "-") return source[index + 1] !== char;
	if (char === "!") return source[index + 1] === "=";
	if ("([.`?*/%&|^<>=,:".includes(char)) return true;
	return /^(?:in|instanceof)(?![$_\p{ID_Continue}\\\u200c\u200d])/u.test(source.slice(index));
}

/** Whether the original CommonJS source opts into strict mode with a directive prologue. */
export function hasUseStrictDirective(source: string): boolean {
	let index = 0;
	if (source.startsWith("#!")) {
		const lineEnd = source.indexOf("\n");
		index = lineEnd === -1 ? source.length : lineEnd + 1;
	}
	for (;;) {
		index = skipTrivia(source, index).index;
		const start = index;
		const end = stringLiteralEnd(source, index);
		if (end === undefined) return false;
		const strict = source.slice(start, end) === '"use strict"' || source.slice(start, end) === "'use strict'";
		const after = skipTrivia(source, end);
		if (source[after.index] === ";") {
			if (strict) return true;
			index = after.index + 1;
			continue;
		}
		if (strict && (after.index === source.length || source[after.index] === "}")) return true;
		if (strict && after.hasLineTerminator && !isStringExpressionContinuation(source, after.index)) return true;
		if (!after.hasLineTerminator || (source[after.index] !== '"' && source[after.index] !== "'")) return false;
		index = after.index;
	}
}

/**
 * Every function in this module, as source text. The importer keys its prepared-source cache on it, so an edit to
 * any helper here (not only the exported one) invalidates entries whose CommonJS bodies it shaped.
 */
export const strictDirectiveModuleSource = [
	skipTrivia,
	stringLiteralEnd,
	isStringExpressionContinuation,
	hasUseStrictDirective,
]
	.map(String)
	.join("\n");
