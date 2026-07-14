import type { Tool } from "../../../types.ts";
import type { ParserOptions, StreamParser, StreamParserEvent } from "../../types.ts";
import { coerceParameters } from "./coerce-parameters.ts";
import { findNextInvokeMatch } from "./invoke-match.ts";
import {
	findIncompleteInvokeOpenTag,
	findInvokeOpenTag,
	getSafeInvokeTextLength,
	scanInvokeBlock,
} from "./invoke-tag-scanner.ts";
import { parseAnthropicXmlGeneratedText } from "./parse.ts";
import {
	ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH,
	createPendingFragment,
	type PendingFragment,
} from "./stream-boundary.ts";
import { createToolResolver } from "./tool-resolver.ts";

export { ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH } from "./stream-boundary.ts";

const FUNCTION_CALLS_OPEN_TAG = /<\s*function_calls\s*>/;
const FUNCTION_CALLS_CLOSE_TAG = /<\s*\/\s*function_calls\s*>/;
const FUNCTION_CALLS_COMPLETE_TAG = /^<\s*\/?\s*function_calls\s*>/;
const FUNCTION_CALLS_OPEN_PREFIX = "<function_calls>";
const FUNCTION_CALLS_CLOSE_PREFIX = "</function_calls>";
const EAGER_OPEN_TAG_SCAN_LENGTH = 128;
const RETAINED_FRAGMENT_OVERFLOW_MESSAGE = `Anthropic XML streaming fragment exceeded the ${ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH}-character retained-input limit.`;

type FunctionCallsTag = {
	readonly index: number;
	readonly length: number;
};

function shouldEmitRawToolCallTextOnError(options?: ParserOptions): boolean {
	return options?.emitRawToolCallTextOnError === true;
}

function emitText(events: StreamParserEvent[], text: string): void {
	if (text.length > 0) {
		events.push({ type: "text", text });
	}
}

function findFunctionCallsTag(pattern: RegExp, text: string, fromIndex: number): FunctionCallsTag | null {
	const match = pattern.exec(text.slice(fromIndex));
	if (!match || match.index === undefined) {
		return null;
	}

	return { index: fromIndex + match.index, length: match[0].length };
}

function isPotentialFunctionCallsTag(candidate: string): boolean {
	if (FUNCTION_CALLS_COMPLETE_TAG.test(candidate)) {
		return false;
	}
	const compactCandidate = candidate.replace(/\s/g, "");
	return (
		FUNCTION_CALLS_OPEN_PREFIX.startsWith(compactCandidate) ||
		FUNCTION_CALLS_CLOSE_PREFIX.startsWith(compactCandidate)
	);
}

function getSafeStreamTextLength(text: string): number {
	const scannerSafeLength = getSafeInvokeTextLength(text);
	const lastTagIndex = text.lastIndexOf("<");
	if (lastTagIndex === -1) {
		return scannerSafeLength;
	}

	return isPotentialFunctionCallsTag(text.slice(lastTagIndex))
		? Math.min(scannerSafeLength, lastTagIndex)
		: scannerSafeLength;
}

function reportError(options: ParserOptions | undefined, message: string, toolCall: string): void {
	options?.onError?.(message, { toolCall });
}

export function createAnthropicXmlStreamParser(tools: Tool[], options?: ParserOptions): StreamParser {
	const resolveTool = createToolResolver(tools);
	let buffer = "";
	let nextToolCallIndex = 0;
	let pendingFragment: PendingFragment | null = null;

	function retainPendingFragment(kind: PendingFragment["kind"]): void {
		pendingFragment = createPendingFragment(kind, buffer);
	}

	function overflowPendingFragment(): StreamParserEvent[] {
		const retainedFragment = buffer;
		buffer = "";
		pendingFragment = null;
		reportError(options, RETAINED_FRAGMENT_OVERFLOW_MESSAGE, retainedFragment);

		const events: StreamParserEvent[] = [];
		if (shouldEmitRawToolCallTextOnError(options)) {
			emitText(events, retainedFragment);
		}
		return events;
	}

	function processBuffer(): StreamParserEvent[] {
		const events: StreamParserEvent[] = [];
		pendingFragment = null;

		while (buffer.length > 0) {
			const invokeOpenTag = findInvokeOpenTag(buffer, 0);
			const functionCallsOpenTag = findFunctionCallsTag(FUNCTION_CALLS_OPEN_TAG, buffer, 0);

			if (functionCallsOpenTag && (!invokeOpenTag || functionCallsOpenTag.index <= invokeOpenTag.index)) {
				if (functionCallsOpenTag.index > 0) {
					emitText(events, buffer.slice(0, functionCallsOpenTag.index));
					buffer = buffer.slice(functionCallsOpenTag.index);
					continue;
				}

				const functionCallsCloseTag = findFunctionCallsTag(
					FUNCTION_CALLS_CLOSE_TAG,
					buffer,
					functionCallsOpenTag.length,
				);
				if (!functionCallsCloseTag) {
					retainPendingFragment("function-calls");
					break;
				}

				const wrapperEnd = functionCallsCloseTag.index + functionCallsCloseTag.length;
				const wrapperContent = buffer.slice(functionCallsOpenTag.length, functionCallsCloseTag.index);
				if (parseAnthropicXmlGeneratedText(wrapperContent, tools).length > 0) {
					buffer = wrapperContent + buffer.slice(wrapperEnd);
				} else {
					emitText(events, buffer.slice(0, wrapperEnd));
					buffer = buffer.slice(wrapperEnd);
				}
				continue;
			}

			if (invokeOpenTag) {
				if (invokeOpenTag.index > 0) {
					emitText(events, buffer.slice(0, invokeOpenTag.index));
					buffer = buffer.slice(invokeOpenTag.index);
					continue;
				}

				const tool = resolveTool(invokeOpenTag.toolName);
				const block = scanInvokeBlock(buffer, invokeOpenTag);
				if (!tool) {
					const nextKnownInvoke = findNextInvokeMatch(
						buffer,
						invokeOpenTag.index + invokeOpenTag.length,
						(toolName) => resolveTool(toolName) !== undefined,
					);
					if (
						nextKnownInvoke &&
						(block === null || (nextKnownInvoke.block !== null && nextKnownInvoke.block.end === block.end))
					) {
						emitText(events, buffer.slice(0, nextKnownInvoke.openingTag.index));
						buffer = buffer.slice(nextKnownInvoke.openingTag.index);
						continue;
					}
				}
				if (!block) {
					retainPendingFragment("invoke");
					break;
				}

				const originalCallText = buffer.slice(0, block.end);
				buffer = buffer.slice(block.end);

				if (!tool) {
					emitText(events, originalCallText);
					continue;
				}

				const index = nextToolCallIndex;
				nextToolCallIndex += 1;
				const id = `anthropic-xml-tool-${index}`;
				const argumentsRecord = block.parameters ? coerceParameters(block.parameters, tool) : null;
				if (argumentsRecord === null) {
					reportError(
						options,
						"Could not process streaming Anthropic XML tool call, keeping original text.",
						originalCallText,
					);
					if (shouldEmitRawToolCallTextOnError(options)) {
						emitText(events, originalCallText);
					}
					continue;
				}

				events.push({ type: "toolcall_start", index, name: tool.name, id });
				events.push({
					type: "toolcall_delta",
					index,
					argumentsDelta: JSON.stringify(argumentsRecord),
				});
				events.push({ type: "toolcall_end", index, name: tool.name, id, arguments: argumentsRecord });
				continue;
			}

			const safeLength = getSafeStreamTextLength(buffer);
			if (safeLength === 0) {
				if (buffer.length >= EAGER_OPEN_TAG_SCAN_LENGTH) {
					retainPendingFragment("open-tag");
				}
				break;
			}
			emitText(events, buffer.slice(0, safeLength));
			buffer = buffer.slice(safeLength);
		}

		return events;
	}

	return {
		feed(textDelta: string): StreamParserEvent[] {
			if (textDelta.length === 0) {
				return [];
			}

			const events: StreamParserEvent[] = [];
			let offset = 0;
			while (offset < textDelta.length) {
				const capacity = ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH - buffer.length;
				if (capacity === 0) {
					events.push(...overflowPendingFragment());
					continue;
				}

				const nextOffset = Math.min(textDelta.length, offset + capacity);
				const chunk = textDelta.slice(offset, nextOffset);
				offset = nextOffset;
				buffer += chunk;

				if (pendingFragment) {
					if (pendingFragment.matcher.feed(chunk)) {
						events.push(...processBuffer());
					}
				} else {
					events.push(...processBuffer());
				}

				if (pendingFragment && buffer.length === ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH) {
					events.push(...overflowPendingFragment());
				}
			}
			return events;
		},
		finish(): StreamParserEvent[] {
			const events = processBuffer();
			if (buffer.length === 0) {
				return events;
			}

			const invokeOpenTag = findInvokeOpenTag(buffer, 0) ?? findIncompleteInvokeOpenTag(buffer, 0);
			if (invokeOpenTag && invokeOpenTag.index === 0 && resolveTool(invokeOpenTag.toolName)) {
				reportError(options, "Could not complete streaming Anthropic XML tool call at finish.", buffer);
				if (shouldEmitRawToolCallTextOnError(options)) {
					emitText(events, buffer);
				}
			} else {
				emitText(events, buffer);
			}
			buffer = "";
			return events;
		},
	};
}
