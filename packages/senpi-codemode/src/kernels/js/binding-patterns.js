import { IDENTIFIER_RE, skipBlockComment, skipLineComment, skipQuotedLiteral, skipTemplateLiteral } from "./js-source-scan.js";

// Text helpers for binding patterns (`{ a, b: [c] = d }`) in the declaration persistence rewrite.

export function collectPatternNames(source, bindings) {
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

export function splitPatternElements(source) {
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

export function findTopLevelEquals(source) {
	return findTopLevelCharacter(source, "=");
}

export function findTopLevelColon(source) {
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

export function trimPattern(source) {
	let start = 0;
	while (start < source.length) {
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
	let end = start;
	for (let index = start; index < source.length; index += 1) {
		const char = source[index];
		const next = source[index + 1];
		if (/\s/u.test(char)) continue;
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
			end = index + 1;
			continue;
		}
		if (char === "`") {
			index = skipTemplateLiteral(source, index) - 1;
			end = index + 1;
			continue;
		}
		end = index + 1;
	}
	return source.slice(start, end);
}
