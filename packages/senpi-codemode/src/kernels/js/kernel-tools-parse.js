import { kernelToolError } from "./kernel-tools-errors.js";

const IDENT = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u;
const RESERVED = new Set(
	"await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield".split(
		" ",
	),
);

export function parseToolFunction(fn) {
	if (typeof fn !== "function") fail();
	const source = fn.toString();
	if (source.includes("[native code]")) fail("tool() cannot wrap native functions");
	return parseHead(source);
}

function parseHead(source) {
	const pos = { i: 0, source };
	skipTrivia(pos);
	if (keyword(pos, "class")) fail();
	let async = false;
	if (keyword(pos, "async")) {
		skipTrivia(pos);
		if (!keyword(pos, "function")) fail();
		async = true;
	} else if (!keyword(pos, "function")) fail();
	skipTrivia(pos);
	if (peek(pos) === "*") fail();
	const name = ident(pos);
	if (!name) fail();
	skipTrivia(pos);
	if (peek(pos) !== "(") fail();
	return { name, params: readParams(pos), async };
}

function readParams(pos) {
	const parts = splitTopLevel(extractParenInner(pos));
	if (parts.length === 1 && plainIdent(parts[0]) === "") return [];
	return parts.map((part) => {
		const name = plainIdent(part);
		if (!name) fail("tool() requires simple identifier parameters");
		return name;
	});
}

function plainIdent(part) {
	const pos = { i: 0, source: part };
	skipTrivia(pos);
	if (eof(pos)) return "";
	const name = ident(pos);
	if (!name) return null;
	skipTrivia(pos);
	return eof(pos) ? name : null;
}

function splitTopLevel(source) {
	const parts = [];
	let current = "";
	const pos = { i: 0, source };
	let paren = 0;
	let square = 0;
	let curly = 0;
	while (!eof(pos)) {
		const start = pos.i;
		if (skipValue(pos)) {
			current += source.slice(start, pos.i);
			continue;
		}
		const ch = source[pos.i];
		pos.i += 1;
		if (ch === "(") paren += 1;
		else if (ch === ")") paren -= 1;
		else if (ch === "[") square += 1;
		else if (ch === "]") square -= 1;
		else if (ch === "{") curly += 1;
		else if (ch === "}") curly -= 1;
		if (ch === "," && paren === 0 && square === 0 && curly === 0) {
			parts.push(current);
			current = "";
		} else current += ch;
	}
	parts.push(current);
	return parts;
}

function extractParenInner(pos) {
	const source = pos.source;
	if (source[pos.i] !== "(") fail();
	pos.i += 1;
	const start = pos.i;
	let paren = 1;
	while (pos.i < source.length && paren > 0) {
		const before = pos.i;
		if (skipValue(pos)) continue;
		if (pos.i !== before) continue;
		const ch = source[pos.i];
		pos.i += 1;
		if (ch === "(") paren += 1;
		else if (ch === ")") paren -= 1;
	}
	if (paren !== 0) fail();
	return source.slice(start, pos.i - 1);
}

function skipValue(pos) {
	const ch = peek(pos);
	if (ch === "'" || ch === '"') {
		pos.i = skipString(pos.source, pos.i);
		return true;
	}
	if (ch === "`") {
		pos.i = skipTemplate(pos.source, pos.i);
		return true;
	}
	if (ch === "/" && pos.source[pos.i + 1] === "/") {
		pos.i = skipLineComment(pos.source, pos.i);
		return true;
	}
	if (ch === "/" && pos.source[pos.i + 1] === "*") {
		pos.i = skipBlockComment(pos.source, pos.i);
		return true;
	}
	return false;
}

function skipTrivia(pos) {
	while (!eof(pos)) {
		if (/\s/u.test(peek(pos))) {
			pos.i += 1;
			continue;
		}
		if (peek(pos) === "/" && pos.source[pos.i + 1] === "/") {
			pos.i = skipLineComment(pos.source, pos.i);
			continue;
		}
		if (peek(pos) === "/" && pos.source[pos.i + 1] === "*") {
			pos.i = skipBlockComment(pos.source, pos.i);
			continue;
		}
		return;
	}
}

function keyword(pos, word) {
	if (!pos.source.startsWith(word, pos.i)) return false;
	const next = pos.source[pos.i + word.length];
	if (next !== undefined && isContinue(next)) return false;
	pos.i += word.length;
	return true;
}

function ident(pos) {
	if (eof(pos) || !isStart(peek(pos))) return null;
	const start = pos.i;
	pos.i += 1;
	while (!eof(pos) && isContinue(peek(pos))) pos.i += 1;
	const value = pos.source.slice(start, pos.i);
	if (!IDENT.test(value) || RESERVED.has(value)) {
		pos.i = start;
		return null;
	}
	return value;
}

function peek(pos) {
	return pos.source[pos.i];
}

function eof(pos) {
	return pos.i >= pos.source.length;
}

function fail(message = "tool() requires a named function") {
	throw kernelToolError("invalid_tool_definition", message);
}

function isStart(ch) {
	return /[\p{ID_Start}$_]/u.test(ch);
}

function isContinue(ch) {
	return /[\p{ID_Continue}$\u200c\u200d]/u.test(ch);
}

function skipLineComment(source, i) {
	i += 2;
	while (i < source.length && source[i] !== "\n" && source[i] !== "\r" && source[i] !== "\u2028" && source[i] !== "\u2029") i += 1;
	return i;
}

function skipBlockComment(source, i) {
	const end = source.indexOf("*/", i + 2);
	if (end < 0) fail();
	return end + 2;
}

function skipString(source, i) {
	const quote = source[i];
	i += 1;
	while (i < source.length) {
		if (source[i] === "\\") {
			i += 2;
			continue;
		}
		if (source[i] === quote) return i + 1;
		i += 1;
	}
	fail();
}

function skipTemplate(source, i) {
	i += 1;
	while (i < source.length) {
		if (source[i] === "\\") {
			i += 2;
			continue;
		}
		if (source[i] === "`") return i + 1;
		if (source[i] === "$" && source[i + 1] === "{") {
			i = skipTemplateExpr(source, i + 2);
			continue;
		}
		i += 1;
	}
	fail();
}

function skipTemplateExpr(source, i) {
	let curly = 1;
	while (i < source.length && curly > 0) {
		if (source[i] === "'" || source[i] === '"') {
			i = skipString(source, i);
			continue;
		}
		if (source[i] === "`") {
			i = skipTemplate(source, i);
			continue;
		}
		if (source[i] === "/" && source[i + 1] === "/") {
			i = skipLineComment(source, i);
			continue;
		}
		if (source[i] === "/" && source[i + 1] === "*") {
			i = skipBlockComment(source, i);
			continue;
		}
		if (source[i] === "{") curly += 1;
		else if (source[i] === "}") {
			curly -= 1;
			if (curly === 0) return i + 1;
		}
		i += 1;
	}
	fail();
}
