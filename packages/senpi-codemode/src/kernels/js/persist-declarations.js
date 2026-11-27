import { isKernelGlobal } from "./worker-shadow-guard.js";
import { collectPatternNames, findTopLevelColon, findTopLevelEquals, splitPatternElements, trimPattern } from "./binding-patterns.js";
import { findDeclarationEnd, splitDeclarators } from "./declaration-extent.js";
import { IDENTIFIER_RE, REGEX_PREFIX_KEYWORDS, isDecimalDigit, isExpressionOperator, isIdentifierStart, isLineTerminator, readIdentifier, skipBlockComment, skipLineComment, skipNumberLiteral, skipQuotedLiteral, skipRegexLiteral, skipTemplateLiteral } from "./js-source-scan.js";

export const USER_SCOPE = "__senpiUserScope";

// The persistence rewrite itself writes through `globalThis`, so that one name cannot be shadowed.
const UNSHADOWABLE = new Set(["globalThis"]);

let shadowedNames = null;

function persistTarget(name) {
	if (UNSHADOWABLE.has(name)) {
		throw new Error(
			`eval cell declares top-level \`${name}\`, which the JS kernel needs to keep cell variables between cells. Rename the binding (for example \`${name}Local\`).`,
		);
	}
	if (!isKernelGlobal(name)) return `globalThis[${JSON.stringify(name)}]`;
	if (shadowedNames !== null && !shadowedNames.includes(name)) shadowedNames.push(name);
	return `${USER_SCOPE}[${JSON.stringify(name)}]`;
}

const DECLARATION_KEYWORDS = new Set(["const", "let", "var"]);

/**
 * Rewrites top-level `const`/`let`/`var` onto `globalThis` (or the user scope for a kernel global) so later cells see
 * them; `shadowed` receives the kernel-global names the cell declares. `using` declarations are not rewritten: they
 * belong to the cell and are disposed when it ends.
 */
export function persistTopLevelDeclarations(code, shadowed) {
	shadowedNames = shadowed;
	try {
		return rewriteTopLevelDeclarations(code);
	} finally {
		shadowedNames = null;
	}
}

function rewriteTopLevelDeclarations(code) {
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

function rewriteDeclaration(code, declarationStart, start, end, keyword) {
	const source = code.slice(declarationStart, end);
	const assignments = [];
	const preserveDeclaration = source.includes("//") || source.includes("/*");
	for (const [segmentStart, segmentEnd] of splitDeclarators(code, start, end)) {
		const segment = code.slice(segmentStart, segmentEnd);
		if (!segment.trim()) return undefined;
		const initializerStart = findTopLevelEquals(segment);
		if (initializerStart < 0 && keyword === "const") return undefined;
		const pattern = trimPattern(initializerStart < 0 ? segment : segment.slice(0, initializerStart));
		const bindings = [];
		collectPatternNames(pattern, bindings);
		if (bindings.length === 0) return undefined;
		if (preserveDeclaration) {
			for (const name of bindings) assignments.push(`${persistTarget(name)} = ${name};`);
			continue;
		}
		const target = rewriteBindingPattern(pattern);
		if (target === undefined) return undefined;
		const initializer = initializerStart < 0 ? "undefined" : segment.slice(initializerStart + 1).trim();
		assignments.push(
			`${target.startsWith("{") || target.startsWith("[") ? `;(${target} = ${initializer})` : `${target} = ${initializer}`};`,
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
	if (IDENTIFIER_RE.test(pattern)) return persistTarget(pattern);
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

function applyTextEdits(code, edits) {
	let output = code;
	for (const edit of edits.toSorted((left, right) => right.start - left.start)) {
		output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
	}
	return output;
}
