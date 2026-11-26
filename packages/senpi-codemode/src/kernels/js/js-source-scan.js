// Lexical scanning shared by the cell rewrites: skip comments, strings, templates and regexes; read identifiers.

const IDENTIFIER_START_RE = /[$_\p{ID_Start}]/u;

const IDENTIFIER_CONTINUE_RE = /[$_\p{ID_Continue}\u200c\u200d]/u;

export const IDENTIFIER_RE = /^[\p{ID_Start}$_][\p{ID_Continue}\u200c\u200d]*$/u;

export const REGEX_PREFIX_KEYWORDS = new Set([
	"await",
	"case",
	"delete",
	"do",
	"else",
	"in",
	"instanceof",
	"new",
	"of",
	"return",
	"throw",
	"typeof",
	"void",
	"yield",
]);

export const EXPRESSION_PREFIX_KEYWORDS = new Set(["await", "delete", "new", "throw", "typeof", "void", "yield"]);

export function nextSignificantIndex(code, start) {
	for (let index = start; index < code.length; index += 1) {
		if (/\s/u.test(code[index])) continue;
		if (code.startsWith("//", index)) {
			index = skipLineComment(code, index) - 1;
			continue;
		}
		if (code.startsWith("/*", index)) {
			index = skipBlockComment(code, index) - 1;
			continue;
		}
		return index;
	}
	return code.length;
}

export function isDeclarationContinuation(char) {
	return char !== undefined && /[.[(,+\-*/%&|^?:<>=!~]/u.test(char);
}

export function isExpressionOperator(char) {
	return /[=,+\-*/%&|^?:<>!~]/u.test(char);
}

export function isIdentifierStart(char) {
	return char !== undefined && IDENTIFIER_START_RE.test(char);
}

export function readIdentifier(code, start) {
	let index = start + 1;
	while (index < code.length && IDENTIFIER_CONTINUE_RE.test(code[index])) index += 1;
	return index;
}

export function isDecimalDigit(char) {
	return char !== undefined && /[0-9]/u.test(char);
}

export function skipNumberLiteral(code, start) {
	let index = start + 1;
	while (index < code.length && /[0-9A-Fa-f_xXn.eE]/u.test(code[index])) index += 1;
	return index;
}

export function skipQuotedLiteral(code, start) {
	const quote = code[start];
	for (let index = start + 1; index < code.length; index += 1) {
		if (code[index] === "\\") {
			index += 1;
			continue;
		}
		if (code[index] === quote) return index + 1;
	}
	return code.length;
}

export function skipTemplateLiteral(code, start) {
	for (let index = start + 1; index < code.length; index += 1) {
		const char = code[index];
		if (char === "\\") {
			index += 1;
			continue;
		}
		if (char === "`") return index + 1;
		if (char === "$" && code[index + 1] === "{") {
			index = skipTemplateExpression(code, index + 2) - 1;
		}
	}
	return code.length;
}

export function skipTemplateExpression(code, start) {
	let curly = 1;
	let canStartRegex = true;
	for (let index = start; index < code.length; index += 1) {
		const char = code[index];
		const next = code[index + 1];
		if (char === "/" && next === "/") {
			index = skipLineComment(code, index) - 1;
			continue;
		}
		if (char === "/" && next === "*") {
			index = skipBlockComment(code, index) - 1;
			continue;
		}
		if (char === "'" || char === '"') {
			index = skipQuotedLiteral(code, index) - 1;
			canStartRegex = false;
			continue;
		}
		if (char === "`") {
			index = skipTemplateLiteral(code, index) - 1;
			canStartRegex = false;
			continue;
		}
		if (char === "/" && canStartRegex) {
			index = skipRegexLiteral(code, index) - 1;
			canStartRegex = false;
			continue;
		}
		if (isIdentifierStart(char)) {
			const end = readIdentifier(code, index);
			canStartRegex = REGEX_PREFIX_KEYWORDS.has(code.slice(index, end));
			index = end - 1;
			continue;
		}
		if (char === "{") curly += 1;
		else if (char === "}" && --curly === 0) return index + 1;
		canStartRegex = char === "(" || char === "[" || char === "{" || isExpressionOperator(char) || char === ",";
	}
	return code.length;
}

export function skipRegexLiteral(code, start) {
	let inClass = false;
	for (let index = start + 1; index < code.length; index += 1) {
		const char = code[index];
		if (char === "\\") {
			index += 1;
			continue;
		}
		if (char === "[") {
			inClass = true;
			continue;
		}
		if (char === "]") {
			inClass = false;
			continue;
		}
		if (char === "/" && !inClass) {
			let end = index + 1;
			while (end < code.length && /[A-Za-z]/u.test(code[end])) end += 1;
			return end;
		}
		if (isLineTerminator(char)) return index;
	}
	return code.length;
}

export function skipLineComment(code, start) {
	for (let index = start + 2; index < code.length; index += 1) {
		if (isLineTerminator(code[index])) return index;
	}
	return code.length;
}

export function isLineTerminator(char) {
	return char === "\n" || char === "\r" || char === "\u2028" || char === "\u2029";
}

export function skipBlockComment(code, start) {
	const end = code.indexOf("*/", start + 2);
	return end < 0 ? code.length : end + 2;
}
