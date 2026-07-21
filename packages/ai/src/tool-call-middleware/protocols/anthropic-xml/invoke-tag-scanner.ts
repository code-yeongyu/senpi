import {
	findParameterBoundary,
	findParameterMarkup,
	findParameterOpenTagAt,
	type InvokeOpenTagMatch,
	type InvokeParameter,
	isPotentialProtocolStart,
	isWhitespaceOrInvokeClosePrefix,
} from "./invoke-tag-syntax.ts";

export {
	findIncompleteInvokeOpenTag,
	findInvokeOpenTag,
	type InvokeBlockMatch,
	type InvokeOpenTagMatch,
	type InvokeParameter,
	isPotentialProtocolStart,
	scanInvokeBlock,
} from "./invoke-tag-syntax.ts";

export type TruncatedInvokeBlockMatch = {
	readonly parameters: InvokeParameter[];
	readonly isStructurallyComplete: boolean;
};

/**
 * Scans an invoke whose closing tag may be missing at stream end. A result is
 * structurally complete only when every parameter closed and the residue is
 * whitespace or a proper prefix of the invoke closing tag.
 */
export function scanTruncatedInvokeBlock(text: string, openingTag: InvokeOpenTagMatch): TruncatedInvokeBlockMatch {
	const parameters: InvokeParameter[] = [];
	let cursor = Math.max(0, openingTag.index + openingTag.length);

	while (cursor <= text.length) {
		const remainder = text.slice(cursor);
		if (isWhitespaceOrInvokeClosePrefix(remainder)) {
			return { parameters, isStructurallyComplete: true };
		}

		const leadingWhitespace = /^\s*/.exec(remainder)?.[0].length ?? 0;
		const parameterMarkup = findParameterMarkup(text, cursor + leadingWhitespace);
		if (!parameterMarkup || parameterMarkup.index !== cursor + leadingWhitespace) {
			return { parameters, isStructurallyComplete: false };
		}

		const parameterOpen = findParameterOpenTagAt(text, parameterMarkup.index);
		if (!parameterOpen) {
			return { parameters, isStructurallyComplete: false };
		}

		const valueStart = parameterOpen.index + parameterOpen.length;
		const boundary = findParameterBoundary(text, valueStart);
		if (boundary?.kind !== "parameter-close") {
			return { parameters, isStructurallyComplete: false };
		}

		parameters.push({ name: parameterOpen.name, rawValue: text.slice(valueStart, boundary.match.index) });
		cursor = boundary.match.index + boundary.match.length;
	}

	return { parameters, isStructurallyComplete: false };
}

export function getSafeInvokeTextLength(text: string): number {
	const lastTagIndex = text.lastIndexOf("<");
	if (lastTagIndex === -1) {
		return text.length;
	}

	return isPotentialProtocolStart(text.slice(lastTagIndex)) ? lastTagIndex : text.length;
}
