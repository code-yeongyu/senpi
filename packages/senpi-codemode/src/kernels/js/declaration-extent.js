import { EXPRESSION_PREFIX_KEYWORDS, REGEX_PREFIX_KEYWORDS, isDecimalDigit, isDeclarationContinuation, isExpressionOperator, isIdentifierStart, isLineTerminator, nextSignificantIndex, readIdentifier, skipBlockComment, skipLineComment, skipNumberLiteral, skipQuotedLiteral, skipRegexLiteral, skipTemplateLiteral } from "./js-source-scan.js";

// Where a top-level declaration ends, and where its declarators split.

export function findDeclarationEnd(code, start) {
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

export function splitDeclarators(code, start, end) {
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
	else if (ranges.length > 0 && code.slice(segmentStart, end).trim() !== ";") ranges.push([end, end]);
	return ranges;
}
