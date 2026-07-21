import type { Tool } from "../../../types.ts";
import type { ParserOptions, StreamParserEvent } from "../../types.ts";
import type { InvokeProtocolConfig } from "./invoke-protocol.ts";
import { getSafeInvokeTextLength } from "./invoke-tag-scanner.ts";
import { ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH } from "./stream-boundary.ts";
import { decodeXmlEntities } from "./xml-entities.ts";

const FUNCTION_CALLS_OPEN_TAG = /<\s*(?:antml:)?function_calls\s*>/;
const FUNCTION_CALLS_CLOSE_TAG = /<\s*\/\s*(?:antml:)?function_calls\s*>/;
const FUNCTION_CALLS_COMPLETE_TAG = /^<\s*\/?\s*(?:antml:)?function_calls\s*>/;
const FUNCTION_CALLS_OPEN_PREFIXES = ["<function_calls>", "<antml:function_calls>"] as const;
const FUNCTION_CALLS_CLOSE_PREFIXES = ["</function_calls>", "</antml:function_calls>"] as const;

export type FunctionCallsTag = {
	readonly index: number;
	readonly length: number;
};

export function shouldEmitRawToolCallTextOnError(options?: ParserOptions): boolean {
	return options?.emitRawToolCallTextOnError === true;
}

export function emitText(events: StreamParserEvent[], text: string): void {
	if (text.length > 0) {
		events.push({ type: "text", text });
	}
}

export function findFunctionCallsTag(pattern: RegExp, text: string, fromIndex: number): FunctionCallsTag | null {
	const match = pattern.exec(text.slice(fromIndex));
	return match?.index === undefined ? null : { index: fromIndex + match.index, length: match[0].length };
}

export function findFunctionCallsOpenTag(text: string, fromIndex: number): FunctionCallsTag | null {
	return findFunctionCallsTag(FUNCTION_CALLS_OPEN_TAG, text, fromIndex);
}

export function findFunctionCallsCloseTag(text: string, fromIndex: number): FunctionCallsTag | null {
	return findFunctionCallsTag(FUNCTION_CALLS_CLOSE_TAG, text, fromIndex);
}

export function isPotentialFunctionCallsTag(candidate: string): boolean {
	if (FUNCTION_CALLS_COMPLETE_TAG.test(candidate)) {
		return false;
	}
	const compactCandidate = candidate.replace(/\s/g, "");
	return [...FUNCTION_CALLS_OPEN_PREFIXES, ...FUNCTION_CALLS_CLOSE_PREFIXES].some((prefix) =>
		prefix.startsWith(compactCandidate),
	);
}

export function isWhitespaceOrFunctionCallsClosePrefix(text: string): boolean {
	const compactText = text.replace(/\s/g, "");
	return (
		compactText.length === 0 ||
		FUNCTION_CALLS_CLOSE_PREFIXES.some((prefix) => prefix.startsWith(compactText) && compactText !== prefix)
	);
}

export function getSafeStreamTextLength(text: string): number {
	const scannerSafeLength = getSafeInvokeTextLength(text);
	const lastTagIndex = text.lastIndexOf("<");
	if (lastTagIndex === -1) {
		return scannerSafeLength;
	}
	return isPotentialFunctionCallsTag(text.slice(lastTagIndex))
		? Math.min(scannerSafeLength, lastTagIndex)
		: scannerSafeLength;
}

export function reportError(options: ParserOptions | undefined, message: string, toolCall: string): void {
	options?.onError?.(message, { toolCall });
}

export function overflowPendingFragment(
	options: ParserOptions | undefined,
	label: string,
	retainedFragment: string,
): StreamParserEvent[] {
	reportError(
		options,
		`${label} streaming fragment exceeded the ${ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH}-character retained-input limit.`,
		retainedFragment,
	);
	return shouldEmitRawToolCallTextOnError(options) ? [{ type: "text", text: retainedFragment }] : [];
}

export function reportTruncatedInvoke(
	options: ParserOptions | undefined,
	config: InvokeProtocolConfig,
	retainedLength: number,
): void {
	options?.onError?.(`${config.label} tool call truncated at finish`, { protocol: config.protocol, retainedLength });
}

export function coerceStreamParameters(
	parameters: Parameters<InvokeProtocolConfig["coerce"]>[0],
	tool: Tool,
	config: InvokeProtocolConfig,
	allowJsonSchemaFallback = false,
): Record<string, unknown> | null {
	const coercedParameters = config.coerce(parameters, tool);
	if (coercedParameters !== null || !allowJsonSchemaFallback) {
		return coercedParameters;
	}

	const argumentsRecord: Record<string, unknown> = {};
	for (const parameter of parameters) {
		if (Object.hasOwn(argumentsRecord, parameter.name)) {
			return null;
		}
		const rawValue = decodeXmlEntities(parameter.rawValue);
		try {
			argumentsRecord[parameter.name] = JSON.parse(rawValue);
		} catch {
			argumentsRecord[parameter.name] = rawValue;
		}
	}
	return argumentsRecord;
}
