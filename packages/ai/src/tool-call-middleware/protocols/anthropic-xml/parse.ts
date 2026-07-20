import type { Tool } from "../../../types.ts";
import type { ParsedToolCall, ParserOptions } from "../../types.ts";
import { findNextInvokeMatch } from "./invoke-match.ts";
import type { InvokeProtocolConfig } from "./invoke-protocol.ts";
import { anthropicXmlInvokeConfig } from "./invoke-protocol.ts";
import { findInvokeOpenTag, scanInvokeBlock } from "./invoke-tag-scanner.ts";
import { createToolResolver } from "./tool-resolver.ts";

export function parseInvokeGeneratedText(
	text: string,
	tools: Tool[],
	config: InvokeProtocolConfig,
	options?: ParserOptions,
): ParsedToolCall[] {
	if (text.length === 0 || tools.length === 0) {
		return [];
	}

	const resolveTool = createToolResolver(tools);
	const parsedToolCalls: ParsedToolCall[] = [];
	let cursor = 0;

	while (cursor < text.length) {
		const openingTag = findInvokeOpenTag(text, cursor);
		if (!openingTag) {
			break;
		}

		const tool = resolveTool(openingTag.toolName);
		const block = scanInvokeBlock(text, openingTag);
		if (!tool) {
			const nextKnownInvoke = findNextInvokeMatch(
				text,
				openingTag.index + openingTag.length,
				(toolName) => resolveTool(toolName) !== undefined,
			);
			if (
				nextKnownInvoke &&
				(block === null || (nextKnownInvoke.block !== null && nextKnownInvoke.block.end === block.end))
			) {
				cursor = nextKnownInvoke.openingTag.index;
				continue;
			}
		}
		if (!block) {
			break;
		}

		const originalCallText = text.slice(openingTag.index, block.end);
		cursor = block.end;

		if (!tool) {
			continue;
		}

		const argumentsRecord = block.parameters ? config.coerce(block.parameters, tool) : null;
		if (!argumentsRecord) {
			options?.onError?.(`Could not process ${config.protocol} tool call, keeping original text.`, {
				toolCall: originalCallText,
			});
			continue;
		}

		parsedToolCalls.push({ name: tool.name, arguments: argumentsRecord });
	}

	return parsedToolCalls;
}

export function parseAnthropicXmlGeneratedText(text: string, tools: Tool[], options?: ParserOptions): ParsedToolCall[] {
	return parseInvokeGeneratedText(text, tools, anthropicXmlInvokeConfig, options);
}
