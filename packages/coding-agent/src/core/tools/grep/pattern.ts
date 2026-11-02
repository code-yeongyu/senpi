import { type GrepEngine, GrepEngineError, type GrepEngineRequest, type GrepEngineResult } from "./engine.ts";
import { createRgEngine } from "./rg-engine.ts";

/** Escape unmatched delimiters only; leave character classes, escapes and quantifiers intact. */
export function recoverPattern(pattern: string): string {
	const stack: Array<{ char: string; index: number }> = [];
	const escapedIndices = new Set<number>();
	let inClass = false;
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === "\\") {
			i++;
			continue;
		}
		if (char === "[") inClass = true;
		if (char === "]") inClass = false;
		if (inClass) continue;
		if (char === "{" && /^\{\d+(,\d*)?\}/.test(pattern.slice(i))) {
			i += pattern.slice(i).indexOf("}");
			continue;
		}
		if (char === "{" || char === "}") {
			escapedIndices.add(i);
			continue;
		}
		if (char === "(") stack.push({ char, index: i });
		if (char === ")") {
			if (stack.length) stack.pop();
			else escapedIndices.add(i);
		}
	}
	for (const entry of stack) escapedIndices.add(entry.index);
	return pattern
		.split("")
		.map((char, i) => `${escapedIndices.has(i) ? "\\" : ""}${char}`)
		.join("");
}

export async function searchPattern(
	engine: GrepEngine,
	request: GrepEngineRequest,
	signal?: AbortSignal,
): Promise<{ result: GrepEngineResult; engine: GrepEngine }> {
	let active = engine;
	const search = async (input: GrepEngineRequest): Promise<GrepEngineResult> => {
		try {
			return await active.search(input, signal);
		} catch (error) {
			if (!(error instanceof GrepEngineError) || error.code !== "UNSUPPORTED_REGEX") throw error;
			active = createRgEngine();
			return active.search({ ...input, pcre2: true }, signal);
		}
	};
	let effectivePattern = request.pattern;
	let patternKind: GrepEngineResult["patternKind"] = request.literal ? "literal" : "regex";
	let result: GrepEngineResult;
	try {
		result = await search(request);
	} catch (error) {
		if (!(error instanceof GrepEngineError) || error.code !== "INVALID_PATTERN" || request.literal) throw error;
		effectivePattern = recoverPattern(request.pattern);
		patternKind = "sanitized";
		try {
			result = await search({ ...request, pattern: effectivePattern });
		} catch (retryError) {
			if (!(retryError instanceof GrepEngineError) || retryError.code !== "INVALID_PATTERN") throw retryError;
			effectivePattern = request.pattern;
			patternKind = "literal";
			result = await search({ ...request, literal: true });
		}
	}
	return { result: { ...result, effectivePattern, patternKind }, engine: active };
}
