export function indirectEval(source, filename) {
	const withPragma = filename ? `${source}\n//# sourceURL=${filename}` : source;
	const geval = globalThis.eval;
	return geval(withPragma);
}

export async function awaitMaybePromise(value) {
	if (!value || typeof value !== "object" || typeof value.then !== "function") return value;
	return await value;
}

export function wrapUserCode(code) {
	const persistentCode = persistTopLevelDeclarations(code);
	if (/\breturn\b/u.test(persistentCode)) return `(async () => {\n${persistentCode}\n})()`;
	return `(async () => {\n${captureLastExpression(persistentCode)}\n})()`;
}

const IDENTIFIER_START_RE = /[$_\p{ID_Start}]/u;
const IDENTIFIER_CONTINUE_RE = /[$_\p{ID_Continue}\u200c\u200d]/u;
const IDENTIFIER_RE = /^[\p{ID_Start}$_][\p{ID_Continue}\u200c\u200d]*$/u;
const DECLARATION_KEYWORDS = new Set(["const", "let", "var"]);
const REGEX_PREFIX_KEYWORDS = new Set([
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
const EXPRESSION_PREFIX_KEYWORDS = new Set(["await", "delete", "new", "throw", "typeof", "void", "yield"]);

function persistTopLevelDeclarations(code) {
	const edits = [];
	let round = 0;
	let square = 0;
	let curly = 0;
	let statementStart = true;
	let canStartRegex = true;

	for (let index = 0; index < code.length; index += 1) {
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
			statementStart = false;
			canStartRegex = false;
			continue;
		}
		if (char === "`") {
			index = skipTemplateLiteral(code, index) - 1;
			statementStart = false;
			canStartRegex = false;
			continue;
		}
		if (char === "/" && canStartRegex) {
			index = skipRegexLiteral(code, index) - 1;
			statementStart = false;
			canStartRegex = false;
			continue;
		}
		if (isIdentifierStart(char)) {
			const end = readIdentifier(code, index);
			const token = code.slice(index, end);
			if (round === 0 && square === 0 && curly === 0 && statementStart && DECLARATION_KEYWORDS.has(token)) {
				const declarationEnd = findDeclarationEnd(code, end);
				const replacement = rewriteDeclaration(code, index, end, declarationEnd, token);
				if (replacement !== undefined) edits.push({ start: index, end: declarationEnd, text: replacement });
			}
			statementStart = false;
			canStartRegex = REGEX_PREFIX_KEYWORDS.has(token);
			index = end - 1;
			continue;
		}
		if (isDecimalDigit(char)) {
			index = skipNumberLiteral(code, index) - 1;
			statementStart = false;
			canStartRegex = false;
			continue;
		}
		if (char === "(") {
			round += 1;
			statementStart = false;
			canStartRegex = true;
			continue;
		}
		if (char === ")") {
			round = Math.max(0, round - 1);
			statementStart = false;
			canStartRegex = false;
			continue;
		}
		if (char === "[") {
			square += 1;
			statementStart = false;
			canStartRegex = true;
			continue;
		}
		if (char === "]") {
			square = Math.max(0, square - 1);
			statementStart = false;
			canStartRegex = false;
			continue;
		}
		if (char === "{") {
			curly += 1;
			statementStart = false;
			canStartRegex = true;
			continue;
		}
		if (char === "}") {
			curly = Math.max(0, curly - 1);
			statementStart = curly === 0 && round === 0 && square === 0;
			canStartRegex = false;
			continue;
		}
		if (char === ";") {
			statementStart = round === 0 && square === 0 && curly === 0;
			canStartRegex = true;
			continue;
		}
		if (isLineTerminator(char) && round === 0 && square === 0 && curly === 0) {
			statementStart = true;
			canStartRegex = true;
			continue;
		}
		if (!/\s/u.test(char)) {
			statementStart = false;
			canStartRegex = isExpressionOperator(char);
		}
	}

	return applyTextEdits(code, edits);
}

function findDeclarationEnd(code, start) {
	let round = 0;
	let square = 0;
	let curly = 0;
	let canEnd = false;
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
			canEnd = true;
			canStartRegex = false;
			continue;
		}
		if (char === "`") {
			index = skipTemplateLiteral(code, index) - 1;
			canEnd = true;
			canStartRegex = false;
			continue;
		}
		if (char === "/" && canStartRegex) {
			index = skipRegexLiteral(code, index) - 1;
			canEnd = true;
			canStartRegex = false;
			continue;
		}
		if (isIdentifierStart(char)) {
			const end = readIdentifier(code, index);
			const token = code.slice(index, end);
			canEnd = !EXPRESSION_PREFIX_KEYWORDS.has(token);
			canStartRegex = REGEX_PREFIX_KEYWORDS.has(token);
			index = end - 1;
			continue;
		}
		if (isDecimalDigit(char)) {
			index = skipNumberLiteral(code, index) - 1;
			canEnd = true;
			canStartRegex = false;
			continue;
		}
		if (char === "(") {
			round += 1;
			canEnd = false;
			canStartRegex = true;
			continue;
		}
		if (char === ")") {
			round = Math.max(0, round - 1);
			canEnd = true;
			canStartRegex = false;
			continue;
		}
		if (char === "[") {
			square += 1;
			canEnd = false;
			canStartRegex = true;
			continue;
		}
		if (char === "]") {
			square = Math.max(0, square - 1);
			canEnd = true;
			canStartRegex = false;
			continue;
		}
		if (char === "{") {
			curly += 1;
			canEnd = false;
			canStartRegex = true;
			continue;
		}
		if (char === "}") {
			curly = Math.max(0, curly - 1);
			canEnd = true;
			canStartRegex = false;
			continue;
		}
		if (char === ";" && round === 0 && square === 0 && curly === 0) return index + 1;
		if (char === "," && round === 0 && square === 0 && curly === 0) {
			canEnd = false;
			canStartRegex = true;
			continue;
		}
		if (isLineTerminator(char) && round === 0 && square === 0 && curly === 0 && canEnd) {
			const nextIndex = nextSignificantIndex(code, index + 1);
			if (nextIndex >= code.length || !isDeclarationContinuation(code[nextIndex])) return index;
		}
		if (!/\s/u.test(char)) {
			canEnd = false;
			canStartRegex = isExpressionOperator(char);
		}
	}
	return code.length;
}

function rewriteDeclaration(code, declarationStart, start, end, keyword) {
	const source = code.slice(declarationStart, end);
	const assignments = [];
	const preserveDeclaration = source.includes("//") || source.includes("/*");
	for (const [segmentStart, segmentEnd] of splitDeclarators(code, start, end)) {
		const segment = code.slice(segmentStart, segmentEnd);
		if (!segment.trim()) continue;
		const initializerStart = findTopLevelEquals(segment);
		if (initializerStart < 0 && keyword === "const") return undefined;
		const pattern = trimPattern(initializerStart < 0 ? segment : segment.slice(0, initializerStart));
		const bindings = [];
		collectPatternNames(pattern, bindings);
		if (bindings.length === 0) return undefined;
		const target = rewriteBindingPattern(pattern);
		if (target === undefined) return undefined;
		const initializer = initializerStart < 0 ? "undefined" : segment.slice(initializerStart + 1).trim();
		const [assignmentInitializer, comment] = splitTrailingLineComment(initializer);
		const assignmentComment = preserveDeclaration ? "" : comment;
		assignments.push(
			`${target.startsWith("{") || target.startsWith("[") ? `(${target} = ${assignmentInitializer})` : `${target} = ${assignmentInitializer}`};${assignmentComment}`,
		);
	}
	if (assignments.length === 0) return undefined;
	return preserveDeclaration ? `${source}\n${assignments.join("\n")}` : assignments.join("\n");
}

function rewriteBindingPattern(source) {
	const pattern = trimPattern(source);
	if (!pattern) return undefined;
	const defaultStart = findTopLevelEquals(pattern);
	if (defaultStart >= 0) {
		const target = rewriteBindingPattern(pattern.slice(0, defaultStart));
		return target === undefined ? undefined : `${target} = ${pattern.slice(defaultStart + 1).trim()}`;
	}
	if (IDENTIFIER_RE.test(pattern)) return `globalThis[${JSON.stringify(pattern)}]`;
	if (pattern.startsWith("{") && pattern.endsWith("}")) {
		const properties = splitPatternElements(pattern.slice(1, -1)).map((property) => rewriteObjectBinding(property));
		if (properties.some((property) => property === undefined)) return undefined;
		return `{${properties.filter((property) => property !== undefined).join(", ")}}`;
	}
	if (pattern.startsWith("[") && pattern.endsWith("]")) {
		const elements = splitPatternElements(pattern.slice(1, -1)).map((element) => {
			if (!element.trim()) return "";
			const rest = trimPattern(element).startsWith("...");
			const target = rewriteBindingPattern(rest ? trimPattern(element).slice(3) : element);
			return target === undefined ? undefined : rest ? `...${target}` : target;
		});
		if (elements.some((element) => element === undefined)) return undefined;
		return `[${elements.join(", ")}]`;
	}
	return undefined;
}

function rewriteObjectBinding(source) {
	const property = trimPattern(source);
	if (!property) return "";
	if (property.startsWith("...")) {
		const target = rewriteBindingPattern(property.slice(3));
		return target === undefined ? undefined : `...${target}`;
	}
	const initializerStart = findTopLevelEquals(property);
	const colon = findTopLevelColon(property);
	if (colon >= 0 && (initializerStart < 0 || colon < initializerStart)) {
		const target = rewriteBindingPattern(property.slice(colon + 1));
		return target === undefined ? undefined : `${property.slice(0, colon + 1).trim()} ${target}`;
	}
	if (initializerStart >= 0) {
		const target = rewriteBindingPattern(property.slice(0, initializerStart));
		return target === undefined ? undefined : `${property.slice(0, initializerStart).trim()}: ${target} = ${property.slice(initializerStart + 1).trim()}`;
	}
	const target = rewriteBindingPattern(property);
	return target === undefined ? undefined : `${property}: ${target}`;
}

function collectPatternNames(source, bindings) {
	const pattern = trimPattern(source);
	if (!pattern) return;
	const defaultStart = findTopLevelEquals(pattern);
	if (defaultStart >= 0) {
		collectPatternNames(pattern.slice(0, defaultStart), bindings);
		return;
	}
	if (pattern.startsWith("{") && pattern.endsWith("}")) {
		for (const property of splitPatternElements(pattern.slice(1, -1))) {
			const trimmed = trimPattern(property);
			if (!trimmed) continue;
			if (trimmed.startsWith("...")) {
				collectPatternNames(trimmed.slice(3), bindings);
				continue;
			}
			const equals = findTopLevelEquals(trimmed);
			const colon = findTopLevelColon(trimmed);
			if (colon >= 0 && (equals < 0 || colon < equals)) collectPatternNames(trimmed.slice(colon + 1), bindings);
			else collectPatternNames(equals < 0 ? trimmed : trimmed.slice(0, equals), bindings);
		}
		return;
	}
	if (pattern.startsWith("[") && pattern.endsWith("]")) {
		for (const element of splitPatternElements(pattern.slice(1, -1))) {
			const trimmed = trimPattern(element);
			if (!trimmed) continue;
			collectPatternNames(trimmed.startsWith("...") ? trimmed.slice(3) : trimmed, bindings);
		}
		return;
	}
	const equals = findTopLevelEquals(pattern);
	const name = trimPattern(equals < 0 ? pattern : pattern.slice(0, equals));
	if (IDENTIFIER_RE.test(name)) bindings.push(name);
}

function splitDeclarators(code, start, end) {
	const ranges = [];
	let segmentStart = start;
	let round = 0;
	let square = 0;
	let curly = 0;
	let canStartRegex = true;
	for (let index = start; index < end; index += 1) {
		const char = code[index];
		const next = code[index + 1];
		if (char === "/" && next === "/") {
			index = Math.min(end, skipLineComment(code, index)) - 1;
			continue;
		}
		if (char === "/" && next === "*") {
			index = Math.min(end, skipBlockComment(code, index)) - 1;
			continue;
		}
		if (char === "'" || char === '"') {
			index = Math.min(end, skipQuotedLiteral(code, index)) - 1;
			canStartRegex = false;
			continue;
		}
		if (char === "`") {
			index = Math.min(end, skipTemplateLiteral(code, index)) - 1;
			canStartRegex = false;
			continue;
		}
		if (char === "/" && canStartRegex) {
			index = Math.min(end, skipRegexLiteral(code, index)) - 1;
			canStartRegex = false;
			continue;
		}
		if (char === "(") round += 1;
		else if (char === ")") round = Math.max(0, round - 1);
		else if (char === "[") square += 1;
		else if (char === "]") square = Math.max(0, square - 1);
		else if (char === "{") curly += 1;
		else if (char === "}") curly = Math.max(0, curly - 1);
		else if (char === "," && round === 0 && square === 0 && curly === 0) {
			ranges.push([segmentStart, index]);
			segmentStart = index + 1;
		}
		if (!/\s/u.test(char)) canStartRegex = isExpressionOperator(char) || char === "(" || char === "[" || char === "{";
	}
	if (segmentStart < end && code.slice(segmentStart, end).trim() !== ";") ranges.push([segmentStart, end - (code[end - 1] === ";" ? 1 : 0)]);
	return ranges;
}

function splitPatternElements(source) {
	const elements = [];
	let start = 0;
	let round = 0;
	let square = 0;
	let curly = 0;
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index];
		const next = source[index + 1];
		if (char === "/" && next === "/") {
			index = skipLineComment(source, index) - 1;
			continue;
		}
		if (char === "/" && next === "*") {
			index = skipBlockComment(source, index) - 1;
			continue;
		}
		if (char === "'" || char === '"') {
			index = skipQuotedLiteral(source, index) - 1;
			continue;
		}
		if (char === "`") {
			index = skipTemplateLiteral(source, index) - 1;
			continue;
		}
		if (char === "(") round += 1;
		else if (char === ")") round = Math.max(0, round - 1);
		else if (char === "[") square += 1;
		else if (char === "]") square = Math.max(0, square - 1);
		else if (char === "{") curly += 1;
		else if (char === "}") curly = Math.max(0, curly - 1);
		else if (char === "," && round === 0 && square === 0 && curly === 0) {
			elements.push(source.slice(start, index));
			start = index + 1;
		}
	}
	elements.push(source.slice(start));
	return elements;
}

function findTopLevelEquals(source) {
	return findTopLevelCharacter(source, "=");
}

function findTopLevelColon(source) {
	return findTopLevelCharacter(source, ":");
}

function findTopLevelCharacter(source, target) {
	let round = 0;
	let square = 0;
	let curly = 0;
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index];
		const next = source[index + 1];
		if (char === "/" && next === "/") {
			index = skipLineComment(source, index) - 1;
			continue;
		}
		if (char === "/" && next === "*") {
			index = skipBlockComment(source, index) - 1;
			continue;
		}
		if (char === "'" || char === '"') {
			index = skipQuotedLiteral(source, index) - 1;
			continue;
		}
		if (char === "`") {
			index = skipTemplateLiteral(source, index) - 1;
			continue;
		}
		if (char === "(") round += 1;
		else if (char === ")") round = Math.max(0, round - 1);
		else if (char === "[") square += 1;
		else if (char === "]") square = Math.max(0, square - 1);
		else if (char === "{") curly += 1;
		else if (char === "}") curly = Math.max(0, curly - 1);
		else if (char === target && round === 0 && square === 0 && curly === 0) return index;
	}
	return -1;
}

function applyTextEdits(code, edits) {
	let output = code;
	for (const edit of edits.toSorted((left, right) => right.start - left.start)) {
		output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
	}
	return output;
}

function splitTrailingLineComment(source) {
	let canStartRegex = true;
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index];
		const next = source[index + 1];
		if (char === "/" && next === "/") return [source.slice(0, index).trimEnd(), source.slice(index)];
		if (char === "/" && next === "*") {
			index = skipBlockComment(source, index) - 1;
			continue;
		}
		if (char === "'" || char === '"') {
			index = skipQuotedLiteral(source, index) - 1;
			canStartRegex = false;
			continue;
		}
		if (char === "`") {
			index = skipTemplateLiteral(source, index) - 1;
			canStartRegex = false;
			continue;
		}
		if (char === "/" && canStartRegex) {
			index = skipRegexLiteral(source, index) - 1;
			canStartRegex = false;
			continue;
		}
		if (isIdentifierStart(char)) {
			const end = readIdentifier(source, index);
			canStartRegex = REGEX_PREFIX_KEYWORDS.has(source.slice(index, end));
			index = end - 1;
			continue;
		}
		if (isDecimalDigit(char)) {
			index = skipNumberLiteral(source, index) - 1;
			canStartRegex = false;
			continue;
		}
		if (!/\s/u.test(char)) canStartRegex = isExpressionOperator(char) || char === "(" || char === "[" || char === "{";
	}
	return [source, ""];
}

function trimPattern(source) {
	let start = 0;
	let end = source.length;
	while (start < end) {
		if (/\s/u.test(source[start])) {
			start += 1;
			continue;
		}
		if (source.startsWith("//", start)) {
			start = skipLineComment(source, start);
			continue;
		}
		if (source.startsWith("/*", start)) {
			start = skipBlockComment(source, start);
			continue;
		}
		break;
	}
	while (true) {
		while (end > start && /\s/u.test(source[end - 1])) end -= 1;
		if (end < start + 2 || source.slice(end - 2, end) !== "*/") break;
		const commentStart = source.lastIndexOf("/*", end - 2);
		if (commentStart < start) break;
		end = commentStart;
	}
	return source.slice(start, end);
}

function nextSignificantIndex(code, start) {
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

function isDeclarationContinuation(char) {
	return char !== undefined && /[.[(,+\-*/%&|^?:<>=!~]/u.test(char);
}

function isExpressionOperator(char) {
	return /[=,+\-*/%&|^?:<>!~]/u.test(char);
}

function isIdentifierStart(char) {
	return char !== undefined && IDENTIFIER_START_RE.test(char);
}

function readIdentifier(code, start) {
	let index = start + 1;
	while (index < code.length && IDENTIFIER_CONTINUE_RE.test(code[index])) index += 1;
	return index;
}

function isDecimalDigit(char) {
	return char !== undefined && /[0-9]/u.test(char);
}

function skipNumberLiteral(code, start) {
	let index = start + 1;
	while (index < code.length && /[0-9A-Fa-f_xXn.eE]/u.test(code[index])) index += 1;
	return index;
}

function skipQuotedLiteral(code, start) {
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

function skipTemplateLiteral(code, start) {
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

function skipTemplateExpression(code, start) {
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

function skipRegexLiteral(code, start) {
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

function skipLineComment(code, start) {
	for (let index = start + 2; index < code.length; index += 1) {
		if (isLineTerminator(code[index])) return index;
	}
	return code.length;
}

function isLineTerminator(char) {
	return char === "\n" || char === "\r" || char === "\u2028" || char === "\u2029";
}

function skipBlockComment(code, start) {
	const end = code.indexOf("*/", start + 2);
	return end < 0 ? code.length : end + 2;
}

function captureLastExpression(code) {
	const start = findLastTopLevelStatementStart(code);
	const head = code.slice(0, start);
	const tail = code.slice(start).trim();
	if (!tail || isStatementOnly(tail)) return code;
	return `${head}return ${tail.replace(/;+$/u, "")};`;
}

function isStatementOnly(source) {
	return /^(?:const|let|var|if|for|while|switch|try|catch|finally|class|function|import|export|throw|return|do|break|continue|debugger)\b/u.test(
		source,
	);
}

function findLastTopLevelStatementStart(code) {
	let start = 0;
	let round = 0;
	let square = 0;
	let curly = 0;
	let quote = "";
	let escaped = false;
	let lineComment = false;
	let blockComment = false;
	for (let index = 0; index < code.length; index += 1) {
		const char = code[index];
		const next = code[index + 1];
		if (lineComment) {
			if (char === "\n") lineComment = false;
			continue;
		}
		if (blockComment) {
			if (char === "*" && next === "/") {
				blockComment = false;
				index += 1;
			}
			continue;
		}
		if (quote) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === quote) {
				quote = "";
			}
			continue;
		}
		if (char === "/" && next === "/") {
			lineComment = true;
			index += 1;
			continue;
		}
		if (char === "/" && next === "*") {
			blockComment = true;
			index += 1;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char;
			continue;
		}
		if (char === "(") round += 1;
		else if (char === ")") round -= 1;
		else if (char === "[") square += 1;
		else if (char === "]") square -= 1;
		else if (char === "{") curly += 1;
		else if (char === "}") curly -= 1;
		else if ((char === ";" || char === "\n") && round === 0 && square === 0 && curly === 0) start = index + 1;
	}
	return start;
}
