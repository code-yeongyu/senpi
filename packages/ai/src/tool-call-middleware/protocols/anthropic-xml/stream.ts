import type { Tool } from "../../../types.ts";
import { validateToolArguments } from "../../../utils/validation.ts";
import type { ParserOptions, StreamParser, StreamParserEvent } from "../../types.ts";
import { findNextInvokeMatch } from "./invoke-match.ts";
import type { InvokeProtocolConfig } from "./invoke-protocol.ts";
import { anthropicXmlInvokeConfig } from "./invoke-protocol.ts";
import {
	coerceStreamParameters,
	emitText,
	findFunctionCallsCloseTag,
	findFunctionCallsOpenTag,
	getSafeStreamTextLength,
	isWhitespaceOrFunctionCallsClosePrefix,
	overflowPendingFragment,
	reportError,
	reportTruncatedInvoke,
	shouldEmitRawToolCallTextOnError,
} from "./invoke-stream-helpers.ts";
import {
	findIncompleteInvokeOpenTag,
	findInvokeOpenTag,
	isPotentialProtocolStart,
	scanInvokeBlock,
	scanTruncatedInvokeBlock,
} from "./invoke-tag-scanner.ts";
import { parseInvokeGeneratedText } from "./parse.ts";
import {
	ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH,
	createPendingFragment,
	type PendingFragment,
} from "./stream-boundary.ts";
import { createToolResolver } from "./tool-resolver.ts";

export { ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH } from "./stream-boundary.ts";

export function createInvokeStreamParser(
	tools: Tool[],
	config: InvokeProtocolConfig,
	options?: ParserOptions,
): StreamParser {
	const resolveTool = createToolResolver(tools);
	let buffer = "";
	let nextToolCallIndex = 0;
	let pendingFragment: PendingFragment | null = null;

	function overflowRetainedFragment(): StreamParserEvent[] {
		const retainedFragment = buffer;
		buffer = "";
		pendingFragment = null;
		return overflowPendingFragment(options, config.label, retainedFragment);
	}

	function processBuffer(consumeFunctionCallsResidue = false, allowJsonSchemaFallback = false): StreamParserEvent[] {
		const events: StreamParserEvent[] = [];
		pendingFragment = null;

		while (buffer.length > 0) {
			const invokeOpenTag = findInvokeOpenTag(buffer, 0);
			const functionCallsOpenTag = findFunctionCallsOpenTag(buffer, 0);

			if (functionCallsOpenTag && (!invokeOpenTag || functionCallsOpenTag.index <= invokeOpenTag.index)) {
				if (functionCallsOpenTag.index > 0) {
					emitText(events, buffer.slice(0, functionCallsOpenTag.index));
					buffer = buffer.slice(functionCallsOpenTag.index);
					continue;
				}

				const functionCallsCloseTag = findFunctionCallsCloseTag(buffer, functionCallsOpenTag.length);
				if (!functionCallsCloseTag) {
					pendingFragment = createPendingFragment("function-calls", buffer);
					break;
				}

				const wrapperEnd = functionCallsCloseTag.index + functionCallsCloseTag.length;
				const wrapperContent = buffer.slice(functionCallsOpenTag.length, functionCallsCloseTag.index);
				if (parseInvokeGeneratedText(wrapperContent, tools, config).length > 0) {
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
					pendingFragment = createPendingFragment("invoke", buffer);
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
				const id = `${config.idPrefix}-${index}`;
				const argumentsRecord = block.parameters
					? coerceStreamParameters(block.parameters, tool, config, allowJsonSchemaFallback)
					: null;
				if (argumentsRecord === null) {
					reportError(
						options,
						`Could not process streaming ${config.label} tool call, keeping original text.`,
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

			if (consumeFunctionCallsResidue && isWhitespaceOrFunctionCallsClosePrefix(buffer)) {
				buffer = "";
				break;
			}

			const safeLength = getSafeStreamTextLength(buffer);
			if (safeLength === 0) {
				if (buffer.length >= 128) {
					pendingFragment = createPendingFragment("open-tag", buffer);
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
					events.push(...overflowRetainedFragment());
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
					events.push(...overflowRetainedFragment());
				}
			}
			return events;
		},
		finish(): StreamParserEvent[] {
			const events = processBuffer();
			const functionCallsOpenTag = findFunctionCallsOpenTag(buffer, 0);
			if (
				functionCallsOpenTag?.index === 0 &&
				findFunctionCallsCloseTag(buffer, functionCallsOpenTag.length) === null
			) {
				buffer = buffer.slice(functionCallsOpenTag.length);
				events.push(...processBuffer(true, true));
			}

			if (buffer.length === 0) {
				return events;
			}

			const invokeOpenTag = findInvokeOpenTag(buffer, 0) ?? findIncompleteInvokeOpenTag(buffer, 0);
			const tool = invokeOpenTag?.index === 0 ? resolveTool(invokeOpenTag.toolName) : undefined;
			if (invokeOpenTag && tool) {
				const scannedBlock = scanTruncatedInvokeBlock(buffer, invokeOpenTag);
				const coercedArguments = coerceStreamParameters(scannedBlock.parameters, tool, config, true);
				let recoveredArguments: Record<string, unknown> | null = null;
				if (scannedBlock.isStructurallyComplete && coercedArguments !== null) {
					try {
						recoveredArguments = validateToolArguments(tool, {
							type: "toolCall",
							id: `${config.protocol}-finish-recovery`,
							name: tool.name,
							arguments: coercedArguments,
						});
					} catch {
						recoveredArguments = null;
					}
				}

				const index = nextToolCallIndex;
				nextToolCallIndex += 1;
				const id = `${config.idPrefix}-${index}`;
				const argumentsRecord = recoveredArguments ?? coercedArguments ?? {};
				events.push({ type: "toolcall_start", index, name: tool.name, id });
				events.push({ type: "toolcall_delta", index, argumentsDelta: JSON.stringify(argumentsRecord) });
				if (recoveredArguments) {
					events.push({ type: "toolcall_end", index, name: tool.name, id, arguments: argumentsRecord });
				} else {
					events.push({
						type: "toolcall_end",
						index,
						name: tool.name,
						id,
						arguments: argumentsRecord,
						incomplete: true,
						errorMessage: "Tool call was truncated mid-arguments",
					});
					reportTruncatedInvoke(options, config, buffer.length);
				}
			} else if (invokeOpenTag?.index === 0) {
				emitText(events, buffer);
			} else if (isPotentialProtocolStart(buffer)) {
				reportTruncatedInvoke(options, config, buffer.length);
			} else {
				emitText(events, buffer);
			}
			buffer = "";
			return events;
		},
	};
}

export function createAnthropicXmlStreamParser(tools: Tool[], options?: ParserOptions): StreamParser {
	return createInvokeStreamParser(tools, anthropicXmlInvokeConfig, options);
}
