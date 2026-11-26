import { REGEX_PREFIX_KEYWORDS, isDecimalDigit, isDeclarationContinuation, isExpressionOperator, isIdentifierStart, isLineTerminator, nextSignificantIndex, readIdentifier, skipBlockComment, skipLineComment, skipNumberLiteral, skipQuotedLiteral, skipRegexLiteral, skipTemplateLiteral } from "./js-source-scan.js";

/** True when the cell has a `return` outside any nested function: the cell's own return value wins. */
export function hasTopLevelReturn(code) {
	return scanTopLevelStatements(code).hasTopLevelReturn;
}

/** Returns the cell's last statement as its value when that statement is an expression. */
export function captureLastExpression(code) {
	const { lastStatementStart: start, lastStatementIsBlock } = scanTopLevelStatements(code);
	const head = code.slice(0, start);
	const tail = code.slice(start).trim();
	if (!tail || lastStatementIsBlock || isStatementOnly(tail)) return code;
	return `${head}return ${tail.replace(/;+$/u, "")};`;
}

// oxlint-disable-next-line eslint/no-misleading-character-class -- ECMAScript identifiers permit ZWNJ and ZWJ as individual continuation characters.
const LABEL_PREFIX_RE = /^[\p{ID_Start}$_][\p{ID_Continue}\u200c\u200d$]*\s*:/u;
// `using x = ...` / `await using x = ...`: no line break may separate the keywords and the binding (senpi#7381).
const USING_DECLARATION_RE = /^(?:await[ \t]+)?using[ \t]+(?!(?:in|of|instanceof)\b)[\p{ID_Start}$_]/u;

function isStatementOnly(source) {
	if (
		/^(?:const|let|var|if|for|while|switch|try|catch|finally|class|function|import|export|throw|return|do|break|continue|debugger)\b/u.test(
			source,
		)
	)
		return true;
	return USING_DECLARATION_RE.test(source) || LABEL_PREFIX_RE.test(source);
}

const CONTROL_PAREN_KEYWORDS = new Set(["catch", "for", "if", "switch", "while", "with"]);
// A `{` right after one of these opens a block statement, never an object literal.
const BLOCK_KEYWORDS = new Set(["catch", "do", "else", "finally", "try"]);
const STATEMENT_CONTINUATION_KEYWORDS = new Set(["catch", "else", "finally"]);

/**
 * Finds where the cell's last top-level statement starts. A top-level `{` in statement position (statement start, a
 * control statement's body, a function or class declaration's body) is a block statement: its `}` ends the statement,
 * so whatever follows on the same line starts the next one.
 */
function scanTopLevelStatements(code) {
	let start = 0;
	let round = 0;
	let square = 0;
	let curly = 0;
	let canStartRegex = true;
	let lastSignificant = "";
	let lastToken = "";
	let pendingControlParen = false;
	let afterControlParen = false;
	let declarationHead = false;
	let asyncAtStatementStart = false;
	let topBlock = null;
	let pendingStatementEnd = false;
	let pendingDoWhile = false;
	let hasTopLevelReturn = false;
	const controlParens = [];
	const blockStarts = new Set();
	const atStatementStart = (index) => nextSignificantIndex(code, start) === index;
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
		if (isLineTerminator(char)) {
			if (round === 0 && square === 0 && curly === 0) {
				if (!canStartRegex) {
					const nextIndex = nextSignificantIndex(code, index + 1);
					if (nextIndex < code.length && !isStatementContinuation(code, nextIndex, lastSignificant)) start = nextIndex;
				}
				canStartRegex = true;
			}
			continue;
		}
		if (/\s/u.test(char)) continue;
		const previousToken = lastToken;
		const previousControlClose = afterControlParen;
		lastToken = "";
		afterControlParen = false;
		if (pendingStatementEnd) {
			pendingStatementEnd = false;
			const token = isIdentifierStart(char) ? code.slice(index, readIdentifier(code, index)) : "";
			const continues = STATEMENT_CONTINUATION_KEYWORDS.has(token) || (pendingDoWhile && token === "while");
			if (!continues && char !== ";") start = index;
		}
		if (char === "'" || char === '"' || char === "`") {
			index = (char === "`" ? skipTemplateLiteral(code, index) : skipQuotedLiteral(code, index)) - 1;
			canStartRegex = false;
			lastSignificant = char;
			pendingControlParen = false;
			continue;
		}
		if (char === "/" && canStartRegex) {
			index = skipRegexLiteral(code, index) - 1;
			canStartRegex = false;
			lastSignificant = char;
			pendingControlParen = false;
			continue;
		}
		if (isIdentifierStart(char)) {
			const end = readIdentifier(code, index);
			const token = code.slice(index, end);
			const isPropertyName = lastSignificant === ".";
			const atTopLevel = round === 0 && square === 0 && curly === 0;
			if (token === "return" && atTopLevel && !isPropertyName) hasTopLevelReturn = true;
			if (atTopLevel && !isPropertyName) {
				if (token === "async") asyncAtStatementStart = atStatementStart(index);
				if (token === "function" || token === "class") {
					declarationHead = atStatementStart(index) || (previousToken === "async" && asyncAtStatementStart);
				}
			}
			canStartRegex = !isPropertyName && REGEX_PREFIX_KEYWORDS.has(token);
			pendingControlParen = !isPropertyName && CONTROL_PAREN_KEYWORDS.has(token);
			lastToken = isPropertyName ? "" : token;
			lastSignificant = code[end - 1];
			index = end - 1;
			continue;
		}
		if (isDecimalDigit(char)) {
			index = skipNumberLiteral(code, index) - 1;
			canStartRegex = false;
			lastSignificant = char;
			pendingControlParen = false;
			continue;
		}
		if (char === "(") {
			round += 1;
			controlParens.push(pendingControlParen);
			pendingControlParen = false;
			canStartRegex = true;
			lastSignificant = char;
			continue;
		}
		if (char === ")") {
			round = Math.max(0, round - 1);
			const closesControl = controlParens.pop() === true;
			canStartRegex = closesControl;
			afterControlParen = closesControl && round === 0 && square === 0 && curly === 0;
			lastSignificant = char;
			continue;
		}
		if (char === "{" && round === 0 && square === 0 && curly === 0) {
			const block = declarationHead || previousControlClose || BLOCK_KEYWORDS.has(previousToken) || atStatementStart(index);
			if (block && atStatementStart(index)) blockStarts.add(index);
			topBlock = block ? { doWhile: previousToken === "do" } : null;
			declarationHead = false;
		}
		if (char === "[" || char === "{") {
			if (char === "[") square += 1;
			else curly += 1;
			canStartRegex = true;
			lastSignificant = char;
			pendingControlParen = false;
			continue;
		}
		if (char === "]" || char === "}") {
			if (char === "]") square = Math.max(0, square - 1);
			else curly = Math.max(0, curly - 1);
			const closesBlock = char === "}" && topBlock !== null && round === 0 && square === 0 && curly === 0;
			if (closesBlock) {
				pendingStatementEnd = true;
				pendingDoWhile = topBlock.doWhile;
				topBlock = null;
			}
			canStartRegex = closesBlock;
			lastSignificant = char;
			pendingControlParen = false;
			continue;
		}
		if (char === ";" && round === 0 && square === 0 && curly === 0) {
			const nextIndex = nextSignificantIndex(code, index + 1);
			if (nextIndex < code.length && !isContinuationKeyword(code, nextIndex)) start = nextIndex;
			canStartRegex = true;
			lastSignificant = char;
			pendingControlParen = false;
			continue;
		}
		canStartRegex = isExpressionOperator(char) || char === ",";
		lastSignificant = char;
		pendingControlParen = false;
	}
	return {
		lastStatementStart: start,
		lastStatementIsBlock: blockStarts.has(nextSignificantIndex(code, start)),
		hasTopLevelReturn,
	};
}

function isContinuationKeyword(code, index) {
	if (!isIdentifierStart(code[index])) return false;
	return STATEMENT_CONTINUATION_KEYWORDS.has(code.slice(index, readIdentifier(code, index)));
}

function isStatementContinuation(code, index, previousChar) {
	const char = code[index];
	if (char === "(" || char === "[" || char === "`") return previousChar !== "}" && previousChar !== "";
	if (char === "!" || char === "~") return false;
	if (char !== undefined && isDeclarationContinuation(char)) return true;
	return isContinuationKeyword(code, index);
}
