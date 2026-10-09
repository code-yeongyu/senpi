import type {
	AssistantMessage,
	Context,
	Message,
	SystemMessage,
	TextContent,
	ThinkingContent,
	ToolResultMessage,
	TranscriptContext,
	UserMessage,
} from "../types.ts";
import { contentText } from "../utils/text.ts";
import { getCurrentTools, getInitialSystemMessage, normalizeContext } from "../utils/transcript.ts";
import {
	anthropicXmlFormatToolCall,
	anthropicXmlFormatToolResponse,
	anthropicXmlFormatToolsSystemPrompt,
	createAnthropicXmlStreamParser,
	parseAnthropicXmlGeneratedText,
} from "./protocols/anthropic-xml/index.ts";
import {
	antmlFormatToolCall,
	antmlFormatToolResponse,
	antmlFormatToolsSystemPrompt,
	createAntmlStreamParser,
	parseAntmlGeneratedText,
} from "./protocols/antml/index.ts";
import {
	gemma4CreateStreamParser,
	gemma4FormatToolCall,
	gemma4FormatToolResponse,
	gemma4FormatToolsSystemPrompt,
	gemma4ParseGeneratedText,
} from "./protocols/gemma4.ts";
import {
	hermesCreateStreamParser,
	hermesFormatToolCall,
	hermesFormatToolResponse,
	hermesFormatToolsSystemPrompt,
	hermesParseGeneratedText,
} from "./protocols/hermes.ts";
import {
	createKimiXtmlStreamParser,
	kimiXtmlFormatToolCall,
	kimiXtmlFormatToolResponse,
	kimiXtmlFormatToolsSystemPrompt,
	parseKimiXtmlGeneratedText,
} from "./protocols/kimi-xtml/index.ts";
import {
	createMorphXmlStreamParser,
	morphXmlFormatToolCall,
	morphXmlFormatToolResponse,
	morphXmlFormatToolsSystemPrompt,
	parseMorphXmlGeneratedText,
} from "./protocols/morph-xml.ts";
import {
	createYamlXmlStreamParser,
	parseYamlXmlGeneratedText,
	yamlXmlFormatToolCall,
	yamlXmlFormatToolResponse,
	yamlXmlFormatToolsSystemPrompt,
} from "./protocols/yaml-xml.ts";
import type { ToolCallFormat, ToolCallProtocol } from "./types.ts";

/**
 * Hermes protocol implementation for tool call formatting and parsing.
 */
const hermesProtocol: ToolCallProtocol = {
	formatToolsSystemPrompt: hermesFormatToolsSystemPrompt,
	formatToolResponse: hermesFormatToolResponse,
	formatToolCall: hermesFormatToolCall,
	parseGeneratedText: hermesParseGeneratedText,
	createStreamParser: hermesCreateStreamParser,
};

/**
 * MorphXml protocol implementation for tool call formatting and parsing.
 */
const morphXmlProtocol: ToolCallProtocol = {
	formatToolsSystemPrompt: morphXmlFormatToolsSystemPrompt,
	formatToolResponse: morphXmlFormatToolResponse,
	formatToolCall: morphXmlFormatToolCall,
	parseGeneratedText: parseMorphXmlGeneratedText,
	createStreamParser: createMorphXmlStreamParser,
};

const yamlXmlProtocol: ToolCallProtocol = {
	formatToolsSystemPrompt: yamlXmlFormatToolsSystemPrompt,
	formatToolResponse: yamlXmlFormatToolResponse,
	formatToolCall: yamlXmlFormatToolCall,
	parseGeneratedText: parseYamlXmlGeneratedText,
	createStreamParser: createYamlXmlStreamParser,
};

/**
 * Gemma 4 protocol implementation for tool call formatting and parsing.
 */
const gemma4Protocol: ToolCallProtocol = {
	formatToolsSystemPrompt: gemma4FormatToolsSystemPrompt,
	formatToolResponse: gemma4FormatToolResponse,
	formatToolCall: gemma4FormatToolCall,
	parseGeneratedText: gemma4ParseGeneratedText,
	createStreamParser: gemma4CreateStreamParser,
};

const antmlProtocol: ToolCallProtocol = {
	formatToolsSystemPrompt: antmlFormatToolsSystemPrompt,
	formatToolResponse: antmlFormatToolResponse,
	formatToolCall: antmlFormatToolCall,
	parseGeneratedText: parseAntmlGeneratedText,
	createStreamParser: createAntmlStreamParser,
};

const kimiXtmlProtocol: ToolCallProtocol = {
	formatToolsSystemPrompt: kimiXtmlFormatToolsSystemPrompt,
	formatToolResponse: kimiXtmlFormatToolResponse,
	formatToolCall: kimiXtmlFormatToolCall,
	parseGeneratedText: parseKimiXtmlGeneratedText,
	createStreamParser: createKimiXtmlStreamParser,
};

const anthropicXmlProtocol: ToolCallProtocol = {
	formatToolsSystemPrompt: anthropicXmlFormatToolsSystemPrompt,
	formatToolResponse: anthropicXmlFormatToolResponse,
	formatToolCall: anthropicXmlFormatToolCall,
	parseGeneratedText: parseAnthropicXmlGeneratedText,
	createStreamParser: createAnthropicXmlStreamParser,
};

/**
 * Protocol registry mapping format strings to protocol implementations.
 */
const protocolRegistry: Record<ToolCallFormat, ToolCallProtocol> = {
	"anthropic-xml": anthropicXmlProtocol,
	antml: antmlProtocol,
	hermes: hermesProtocol,
	xml: morphXmlProtocol,
	"morph-xml": morphXmlProtocol,
	"yaml-xml": yamlXmlProtocol,
	"gemma4-delimiter": gemma4Protocol,
	"kimi-xtml": kimiXtmlProtocol,
};

/**
 * Gets the protocol implementation for a given tool call format.
 * @param format - The tool call format
 * @returns The protocol implementation
 * @throws Error if the format is not supported
 */
export function getProtocol(format: ToolCallFormat): ToolCallProtocol {
	const protocol = protocolRegistry[format];
	if (!protocol) {
		throw new Error(`Unsupported tool call format: ${format}`);
	}
	return protocol;
}

/**
 * Transforms a context for text-based tool calling.
 * - Strips tool declarations from every system message (provider sees a tool-free request)
 * - Injects the current tool definitions into the leading system prompt
 * - Converts tool call messages in history to text format
 * - Converts tool result messages to user messages with text content
 *
 * Accepts a raw `Context` or a normalized `TranscriptContext`; both are read through
 * the transcript, so the prompt and tools come from its system messages.
 *
 * @param context - The original context
 * @param protocol - The protocol to use for formatting
 * @returns A new transformed transcript (original is not mutated)
 */
export function transformContext(context: Context, protocol: ToolCallProtocol): TranscriptContext {
	const transcript = normalizeContext(context);
	const tools = getCurrentTools(transcript.messages);
	const toolPrompt = tools.length > 0 ? protocol.formatToolsSystemPrompt(tools) : "";
	const initial = getInitialSystemMessage(transcript.messages);
	const head = initial ? withoutToolDeclarations(initial) : undefined;
	const messages: Message[] = [];

	// Inject tool definitions into the leading system prompt if tools exist
	if (toolPrompt) {
		const leading: SystemMessage = head ?? { role: "system", content: "", timestamp: 0 };
		const basePrompt = contentText(leading.content);
		messages.push({ ...leading, content: basePrompt ? `${toolPrompt}\n\n${basePrompt}` : toolPrompt });
	} else if (head && hasSystemContent(head)) {
		messages.push(head);
	}

	for (const message of initial ? transcript.messages.slice(1) : transcript.messages) {
		if (message.role === "system") {
			const stripped = withoutToolDeclarations(message);
			if (hasSystemContent(stripped)) messages.push(stripped);
			continue;
		}
		messages.push(transformMessage(message, protocol));
	}

	return { messages } as TranscriptContext;
}

/** Copy a system message without its tool deltas; text-protocol requests declare no native tools. */
function withoutToolDeclarations(message: SystemMessage): SystemMessage {
	return {
		role: "system",
		content: message.content,
		...(message.sections ? { sections: message.sections } : {}),
		timestamp: message.timestamp,
	};
}

/** Whether a system message still carries prompt text or sections once its tool deltas are gone. */
function hasSystemContent(message: SystemMessage): boolean {
	return contentText(message.content).length > 0 || Object.keys(message.sections ?? {}).length > 0;
}

/**
 * Transforms a single message for text-based tool calling.
 * - AssistantMessage with ToolCall blocks: convert to text
 * - ToolResultMessage: convert to UserMessage with text content
 * - Other messages: pass through unchanged
 */
function transformMessage(message: Message, protocol: ToolCallProtocol): Message {
	switch (message.role) {
		case "assistant": {
			return transformAssistantMessage(message, protocol);
		}
		case "toolResult": {
			return transformToolResultMessage(message, protocol);
		}
		default: {
			return message;
		}
	}
}

/**
 * Transforms an AssistantMessage, converting ToolCall content blocks to text.
 *
 * Flagged incomplete calls replay as canonical formatted calls from their sanitized parsed arguments; the paired error toolResult (created by agent-loop/pair-repair) is what tells the model the call failed — raw truncated markup never re-enters context.
 */
function transformAssistantMessage(message: AssistantMessage, protocol: ToolCallProtocol): AssistantMessage {
	// Check if message has any ToolCall content blocks
	const hasToolCalls = message.content.some((block) => block.type === "toolCall");
	if (!hasToolCalls) {
		// No tool calls - pass through unchanged
		return message;
	}

	// Transform content blocks
	const newContent: (TextContent | ThinkingContent)[] = [];

	for (const block of message.content) {
		switch (block.type) {
			case "text": {
				newContent.push(block);
				break;
			}
			case "thinking": {
				newContent.push(block);
				break;
			}
			case "toolCall": {
				const toolCallText = protocol.formatToolCall(block.name, block.arguments);
				newContent.push({
					type: "text",
					text: toolCallText,
				});
				break;
			}
		}
	}

	// Return new AssistantMessage with transformed content
	return {
		...message,
		content: newContent,
	};
}

/**
 * Transforms a ToolResultMessage to a UserMessage with text content.
 */
function transformToolResultMessage(message: ToolResultMessage, protocol: ToolCallProtocol): UserMessage {
	// Format tool result as text using protocol formatter
	const formattedResponse = protocol.formatToolResponse(message.toolName, message.toolCallId, message.content);

	// Return as UserMessage with text content
	return {
		role: "user",
		content: formattedResponse,
		timestamp: message.timestamp,
	};
}
