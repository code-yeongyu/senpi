import { decodeXmlEntities } from "./xml-entities.ts";

const PROTOCOL_TAG_NAMES = ["invoke", "parameter", "function_calls"] as const;

const INVOKE_OPEN_TAG_BODY = String.raw`<\s*invoke\b\s+name\s*=\s*(?:"([^"]+)"|'([^']+)')`;
const INVOKE_OPEN_TAG = new RegExp(`${INVOKE_OPEN_TAG_BODY}\\s*>`, "g");
const INVOKE_CLOSE_TAG = /<\s*\/\s*invoke\s*>/g;
const NESTED_INVOKE_OPEN_TAG = /<\s*invoke\b[^>]*>/g;
const PARAMETER_MARKUP = /<\s*\/?\s*parameter\b/g;
const PARAMETER_OPEN_TAG = /<\s*parameter\b\s+name\s*=\s*(?:"([^"]+)"|'([^']+)')\s*>/g;
const PARAMETER_CLOSE_TAG = /<\s*\/\s*parameter\s*>/g;

type TagMatch = {
	readonly index: number;
	readonly length: number;
};

type ParameterOpenTagMatch = TagMatch & {
	readonly name: string;
};

type ParameterBoundary =
	| { readonly kind: "parameter-close"; readonly match: TagMatch }
	| { readonly kind: "invoke-close"; readonly match: TagMatch };

export type InvokeOpenTagMatch = {
	readonly index: number;
	readonly length: number;
	readonly toolName: string;
};

export type InvokeParameter = {
	readonly name: string;
	readonly rawValue: string;
};

export type InvokeBlockMatch = {
	readonly contentEnd: number;
	readonly end: number;
	readonly parameters: InvokeParameter[] | null;
};

function findTag(pattern: RegExp, text: string, fromIndex: number): TagMatch | null {
	pattern.lastIndex = Math.max(0, fromIndex);
	const match = pattern.exec(text);
	return match ? { index: match.index, length: match[0].length } : null;
}

function findParameterOpenTagAt(text: string, index: number): ParameterOpenTagMatch | null {
	PARAMETER_OPEN_TAG.lastIndex = index;
	const match = PARAMETER_OPEN_TAG.exec(text);
	if (!match || match.index !== index) {
		return null;
	}

	const name = match[1] ?? match[2];
	return name ? { index, length: match[0].length, name: decodeXmlEntities(name) } : null;
}

function findParameterBoundary(text: string, fromIndex: number): ParameterBoundary | null {
	let cursor = fromIndex;
	let nestedInvokeDepth = 0;

	while (cursor < text.length) {
		const parameterClose = findTag(PARAMETER_CLOSE_TAG, text, cursor);
		const invokeOpen = findTag(NESTED_INVOKE_OPEN_TAG, text, cursor);
		const invokeClose = findTag(INVOKE_CLOSE_TAG, text, cursor);
		const nextIndex = Math.min(
			parameterClose?.index ?? Number.POSITIVE_INFINITY,
			invokeOpen?.index ?? Number.POSITIVE_INFINITY,
			invokeClose?.index ?? Number.POSITIVE_INFINITY,
		);

		if (!Number.isFinite(nextIndex)) {
			return null;
		}
		if (invokeOpen && invokeOpen.index === nextIndex) {
			const nextParameterClose = findTag(PARAMETER_CLOSE_TAG, text, invokeOpen.index + invokeOpen.length);
			const nestedParameterOpen = findTag(PARAMETER_OPEN_TAG, text, invokeOpen.index + invokeOpen.length);
			const nestedInvokeClose = findTag(INVOKE_CLOSE_TAG, text, invokeOpen.index + invokeOpen.length);
			if (
				nestedInvokeClose === null ||
				((nestedParameterOpen === null || nestedParameterOpen.index > nestedInvokeClose.index) &&
					nextParameterClose !== null &&
					nestedInvokeClose.index > nextParameterClose.index)
			) {
				cursor = invokeOpen.index + invokeOpen.length;
				continue;
			}
			nestedInvokeDepth += 1;
			cursor = invokeOpen.index + invokeOpen.length;
			continue;
		}
		if (invokeClose && invokeClose.index === nextIndex) {
			if (nestedInvokeDepth === 0) {
				return { kind: "invoke-close", match: invokeClose };
			}
			nestedInvokeDepth -= 1;
			cursor = invokeClose.index + invokeClose.length;
			continue;
		}
		if (parameterClose) {
			if (nestedInvokeDepth === 0) {
				return { kind: "parameter-close", match: parameterClose };
			}
			cursor = parameterClose.index + parameterClose.length;
		}
	}

	return null;
}

export function findInvokeOpenTag(text: string, fromIndex: number): InvokeOpenTagMatch | null {
	INVOKE_OPEN_TAG.lastIndex = Math.max(0, fromIndex);
	const match = INVOKE_OPEN_TAG.exec(text);
	if (!match || match.index === undefined) {
		return null;
	}

	const toolName = match[1] ?? match[2];
	return toolName ? { index: match.index, length: match[0].length, toolName: decodeXmlEntities(toolName) } : null;
}

export function findIncompleteInvokeOpenTag(text: string, fromIndex: number): InvokeOpenTagMatch | null {
	const index = Math.max(0, fromIndex);
	const candidate = text.slice(index);
	const match = /^<\s*invoke\b\s+name\s*=\s*/.exec(candidate);
	if (!match) {
		return null;
	}

	const quoteIndex = match[0].length;
	const quote = candidate[quoteIndex];
	if (quote !== '"' && quote !== "'") {
		return null;
	}

	const toolNameStart = quoteIndex + 1;
	const closingQuoteIndex = candidate.indexOf(quote, toolNameStart);
	if (closingQuoteIndex === -1) {
		const toolName = decodeXmlEntities(candidate.slice(toolNameStart));
		return toolName.length > 0 ? { index, length: candidate.length, toolName } : null;
	}

	const toolName = decodeXmlEntities(candidate.slice(toolNameStart, closingQuoteIndex));
	if (toolName.length === 0 || candidate.slice(closingQuoteIndex + 1).trim().length > 0) {
		return null;
	}

	return { index, length: candidate.length, toolName };
}

export function scanInvokeBlock(text: string, openingTag: InvokeOpenTagMatch): InvokeBlockMatch | null {
	const parameters: InvokeParameter[] = [];
	let cursor = Math.max(0, openingTag.index + openingTag.length);

	while (cursor <= text.length) {
		const invokeClose = findTag(INVOKE_CLOSE_TAG, text, cursor);
		if (!invokeClose) {
			return null;
		}

		const parameterMarkup = findTag(PARAMETER_MARKUP, text, cursor);
		const nestedInvokeOpen = findTag(NESTED_INVOKE_OPEN_TAG, text, cursor);
		if (
			nestedInvokeOpen &&
			nestedInvokeOpen.index < invokeClose.index &&
			(!parameterMarkup || nestedInvokeOpen.index < parameterMarkup.index)
		) {
			return null;
		}
		if (!parameterMarkup || invokeClose.index < parameterMarkup.index) {
			return {
				contentEnd: invokeClose.index,
				end: invokeClose.index + invokeClose.length,
				parameters,
			};
		}

		const parameterOpen = findParameterOpenTagAt(text, parameterMarkup.index);
		if (!parameterOpen) {
			return {
				contentEnd: invokeClose.index,
				end: invokeClose.index + invokeClose.length,
				parameters: null,
			};
		}

		const valueStart = parameterOpen.index + parameterOpen.length;
		const boundary = findParameterBoundary(text, valueStart);
		if (!boundary) {
			return null;
		}

		switch (boundary.kind) {
			case "invoke-close":
				return {
					contentEnd: boundary.match.index,
					end: boundary.match.index + boundary.match.length,
					parameters: null,
				};
			case "parameter-close":
				parameters.push({
					name: parameterOpen.name,
					rawValue: text.slice(valueStart, boundary.match.index),
				});
				cursor = boundary.match.index + boundary.match.length;
				break;
		}
	}

	return null;
}

function isAttributePrefix(remainder: string): boolean {
	const attributeMatch = /^(\s*)([A-Za-z]*)/.exec(remainder);
	if (!attributeMatch) {
		return false;
	}

	const attributeName = attributeMatch[2] ?? "";
	const afterAttributeName = remainder.slice(attributeMatch[0].length);
	if (attributeName.length < "name".length) {
		return "name".startsWith(attributeName) && afterAttributeName.trim().length === 0;
	}
	if (attributeName !== "name") {
		return false;
	}
	if (afterAttributeName.trim().length === 0) {
		return true;
	}

	const equalsMatch = /^\s*=\s*(.*)$/.exec(afterAttributeName);
	if (!equalsMatch) {
		return false;
	}

	const valuePrefix = equalsMatch[1] ?? "";
	if (valuePrefix.length === 0) {
		return true;
	}

	const quote = valuePrefix[0];
	if (quote !== '"' && quote !== "'") {
		return false;
	}

	const closingQuoteIndex = valuePrefix.indexOf(quote, 1);
	return closingQuoteIndex === -1 || valuePrefix.slice(closingQuoteIndex + 1).trim().length === 0;
}

function isPotentialProtocolStart(candidate: string): boolean {
	if (!candidate.startsWith("<")) {
		return false;
	}

	const body = candidate.slice(1);
	const leadingWhitespace = /^\s*/.exec(body)?.[0] ?? "";
	const namePart = body.slice(leadingWhitespace.length);
	if (namePart.length === 0) {
		return true;
	}

	const tagName = PROTOCOL_TAG_NAMES.find((name) => name.startsWith(namePart) || namePart.startsWith(name));
	if (!tagName) {
		return false;
	}
	if (namePart.length < tagName.length) {
		return true;
	}

	const remainder = namePart.slice(tagName.length);
	if (remainder.includes(">")) {
		return false;
	}
	if (tagName === "function_calls") {
		return /^\s*$/.test(remainder);
	}
	return isAttributePrefix(remainder);
}

export function getSafeInvokeTextLength(text: string): number {
	const lastTagIndex = text.lastIndexOf("<");
	if (lastTagIndex === -1) {
		return text.length;
	}

	return isPotentialProtocolStart(text.slice(lastTagIndex)) ? lastTagIndex : text.length;
}
