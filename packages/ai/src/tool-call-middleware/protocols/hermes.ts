import type { TSchema } from "@sinclair/typebox";
import type { ImageContent, TextContent, Tool } from "../../types.js";
import type { ParsedToolCall, StreamParser, StreamParserEvent } from "../types.js";

const TOOL_CALL_START = "<tool_call>";
const TOOL_CALL_END = "</tool_call>";
const JSON_WHITESPACE_REGEX = /\s/;

/**
 * Renders a single tool definition as Hermes format JSON.
 * Format: {"type": "function", "function": {"name": ..., "description": ..., "parameters": ...}}
 */
function renderToolDefinition(tool: Tool): string {
	const parameters = tool.parameters as TSchema & { static?: unknown };
	const parametersJson = JSON.stringify(parameters);
	const descriptionJson = JSON.stringify(tool.description);
	const nameJson = JSON.stringify(tool.name);

	return `{"type": "function", "function": {"name": ${nameJson}, "description": ${descriptionJson}, "parameters": ${parametersJson}}}`;
}

/**
 * Generates Hermes-style system prompt with tool definitions.
 * Tools are rendered inside <tools></tools> XML tags.
 * Includes pydantic model schema and tool call usage instructions.
 */
export function hermesFormatToolsSystemPrompt(tools: Tool[]): string {
	if (tools.length === 0) {
		return "";
	}

	const toolsRendered = tools.map(renderToolDefinition).join("\n");

	return `You are a function calling AI model. You are provided with function signatures within <tools></tools> XML tags. You may call one or more functions to assist with the user query. Don't make assumptions about what values to plug into functions. Here are the available tools: <tools> ${toolsRendered} </tools>
Use the following pydantic model json schema for each tool call you will make: {"properties": {"name": {"title": "Name", "type": "string"}, "arguments": {"title": "Arguments", "type": "object"}}, "required": ["name", "arguments"], "title": "FunctionCall", "type": "object"}
For each function call return a json object with function name and arguments within <tool_call></tool_call> XML tags as follows:
<tool_call>
{"name": "<function-name>", "arguments": <args-dict>}
</tool_call>`;
}

/**
 * Formats a tool response for Hermes protocol.
 * Format: <tool_response>{"name":"toolName","content":"..."}</tool_response>
 */
export function hermesFormatToolResponse(
	toolName: string,
	_toolCallId: string,
	content: (TextContent | ImageContent)[],
): string {
	const textContent = content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	return `<tool_response>${JSON.stringify({
		name: toolName,
		content: textContent,
	})}</tool_response>`;
}

/**
 * Formats a tool call for Hermes protocol.
 * Format: <tool_call>\n{"name":"name","arguments":{...}}\n</tool_call>
 */
export function hermesFormatToolCall(name: string, args: Record<string, unknown>): string {
	return `<tool_call>\n${JSON.stringify({
		name,
		arguments: args,
	})}\n</tool_call>`;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolNames(tools: Tool[]): Set<string> {
	return new Set(tools.map((tool) => tool.name));
}

function removeTrailingCommas(text: string): string {
	let result = "";
	let inString = false;
	let isEscaping = false;

	for (let index = 0; index < text.length; index += 1) {
		const character = text[index];

		if (inString) {
			result += character;
			if (isEscaping) {
				isEscaping = false;
			} else if (character === "\\") {
				isEscaping = true;
			} else if (character === '"') {
				inString = false;
			}
			continue;
		}

		if (character === '"') {
			inString = true;
			result += character;
			continue;
		}

		if (character === ",") {
			let lookAheadIndex = index + 1;
			while (lookAheadIndex < text.length && JSON_WHITESPACE_REGEX.test(text[lookAheadIndex] ?? "")) {
				lookAheadIndex += 1;
			}

			const nextCharacter = text[lookAheadIndex];
			if (nextCharacter === "}" || nextCharacter === "]") {
				continue;
			}
		}

		result += character;
	}

	return result;
}

function parseRelaxedJson(text: string): unknown {
	return JSON.parse(removeTrailingCommas(text));
}

function parseToolCallJson(text: string, tools: Tool[]): ParsedToolCall | null {
	try {
		const parsedValue = parseRelaxedJson(text);
		if (!isRecord(parsedValue)) {
			return null;
		}

		if (typeof parsedValue.name !== "string") {
			return null;
		}

		if (!normalizeToolNames(tools).has(parsedValue.name)) {
			return null;
		}

		if (!isRecord(parsedValue.arguments)) {
			return null;
		}

		return {
			name: parsedValue.name,
			arguments: parsedValue.arguments,
		};
	} catch {
		return null;
	}
}

function skipJsonWhitespace(text: string, fromIndex: number): number {
	let index = fromIndex;
	while (index < text.length && JSON_WHITESPACE_REGEX.test(text[index] ?? "")) {
		index += 1;
	}
	return index;
}

function findTopLevelPropertyValueStart(text: string, property: string): number | null {
	const objectStart = skipJsonWhitespace(text, 0);
	if (objectStart >= text.length || text.charAt(objectStart) !== "{") {
		return null;
	}

	let depth = 0;
	let inString = false;
	let isEscaping = false;

	for (let index = objectStart; index < text.length; index += 1) {
		const character = text.charAt(index);

		if (inString) {
			if (isEscaping) {
				isEscaping = false;
			} else if (character === "\\") {
				isEscaping = true;
			} else if (character === '"') {
				inString = false;
			}
			continue;
		}

		if (character === "{") {
			depth += 1;
			continue;
		}

		if (character === "}") {
			depth = Math.max(0, depth - 1);
			continue;
		}

		if (character !== '"') {
			continue;
		}

		if (depth !== 1) {
			inString = true;
			continue;
		}

		const keyStart = index + 1;
		let keyEnd = keyStart;
		let keyEscaping = false;
		while (keyEnd < text.length) {
			const keyCharacter = text.charAt(keyEnd);
			if (keyEscaping) {
				keyEscaping = false;
			} else if (keyCharacter === "\\") {
				keyEscaping = true;
			} else if (keyCharacter === '"') {
				break;
			}
			keyEnd += 1;
		}

		if (keyEnd >= text.length || text.charAt(keyEnd) !== '"') {
			return null;
		}

		const key = text.slice(keyStart, keyEnd);
		let valueCursor = skipJsonWhitespace(text, keyEnd + 1);
		if (valueCursor >= text.length || text.charAt(valueCursor) !== ":") {
			index = keyEnd;
			continue;
		}

		valueCursor = skipJsonWhitespace(text, valueCursor + 1);
		if (key === property) {
			return valueCursor < text.length ? valueCursor : null;
		}

		index = valueCursor - 1;
	}

	return null;
}

function extractTopLevelStringProperty(text: string, property: string): string | undefined {
	const valueStart = findTopLevelPropertyValueStart(text, property);
	if (valueStart == null || valueStart >= text.length) {
		return undefined;
	}

	if (text.charAt(valueStart) !== '"') {
		return undefined;
	}

	let valueEnd = valueStart + 1;
	let isEscaping = false;
	while (valueEnd < text.length) {
		const character = text.charAt(valueEnd);
		if (isEscaping) {
			isEscaping = false;
		} else if (character === "\\") {
			isEscaping = true;
		} else if (character === '"') {
			return text.slice(valueStart + 1, valueEnd);
		}
		valueEnd += 1;
	}

	return undefined;
}

function extractJsonValueSlice(text: string, valueStart: number): { text: string; complete: boolean } | null {
	if (valueStart >= text.length) {
		return null;
	}

	const firstCharacter = text.charAt(valueStart);
	if (firstCharacter === "{" || firstCharacter === "[") {
		const stack: string[] = [firstCharacter];
		let inString = false;
		let isEscaping = false;

		for (let index = valueStart + 1; index < text.length; index += 1) {
			const character = text.charAt(index);
			if (inString) {
				if (isEscaping) {
					isEscaping = false;
				} else if (character === "\\") {
					isEscaping = true;
				} else if (character === '"') {
					inString = false;
				}
				continue;
			}

			if (character === '"') {
				inString = true;
				continue;
			}

			if (character === "{" || character === "[") {
				stack.push(character);
				continue;
			}

			if (character === "}" || character === "]") {
				const openCharacter = stack[stack.length - 1];
				if ((openCharacter === "{" && character === "}") || (openCharacter === "[" && character === "]")) {
					stack.pop();
					if (stack.length === 0) {
						return {
							text: text.slice(valueStart, index + 1),
							complete: true,
						};
					}
				}
			}
		}

		return {
			text: text.slice(valueStart),
			complete: false,
		};
	}

	if (firstCharacter === '"') {
		let isEscaping = false;
		for (let index = valueStart + 1; index < text.length; index += 1) {
			const character = text.charAt(index);
			if (isEscaping) {
				isEscaping = false;
			} else if (character === "\\") {
				isEscaping = true;
			} else if (character === '"') {
				return {
					text: text.slice(valueStart, index + 1),
					complete: true,
				};
			}
		}

		return {
			text: text.slice(valueStart),
			complete: false,
		};
	}

	let index = valueStart;
	while (index < text.length) {
		const character = text.charAt(index);
		if (character === "," || character === "}" || JSON_WHITESPACE_REGEX.test(character)) {
			break;
		}
		index += 1;
	}

	return {
		text: text.slice(valueStart, index),
		complete: index < text.length,
	};
}

function getPotentialStartIndex(text: string, searchedText: string): number | null {
	if (searchedText.length === 0) {
		return null;
	}

	const directIndex = text.indexOf(searchedText);
	if (directIndex !== -1) {
		return directIndex;
	}

	const startAt = Math.max(0, text.length - searchedText.length + 1);
	for (let index = startAt; index < text.length; index += 1) {
		let isMatch = true;
		const suffixLength = text.length - index;

		for (let suffixIndex = 0; suffixIndex < suffixLength; suffixIndex += 1) {
			if (text[index + suffixIndex] !== searchedText[suffixIndex]) {
				isMatch = false;
				break;
			}
		}

		if (isMatch) {
			return index;
		}
	}

	return null;
}

function extractArgumentsProgress(toolCallJson: string): {
	toolName: string | undefined;
	argumentsText: string | undefined;
	argumentsComplete: boolean;
} {
	const toolName = extractTopLevelStringProperty(toolCallJson, "name");
	const argumentsStart = findTopLevelPropertyValueStart(toolCallJson, "arguments");
	if (argumentsStart == null) {
		return {
			toolName,
			argumentsText: undefined,
			argumentsComplete: false,
		};
	}

	const argumentsSlice = extractJsonValueSlice(toolCallJson, argumentsStart);
	return {
		toolName,
		argumentsText: argumentsSlice?.text,
		argumentsComplete: argumentsSlice?.complete ?? false,
	};
}

function createToolCallId(index: number): string {
	return `hermes-tool-${index}`;
}

type StreamState = {
	activeToolCall: {
		index: number;
		id: string;
		name: string;
		emittedArguments: string;
	} | null;
	buffer: string;
	currentToolCallJson: string;
	isInsideToolCall: boolean;
	toolCallCount: number;
};

function emitText(events: StreamParserEvent[], text: string): void {
	if (text.length === 0) {
		return;
	}

	events.push({ type: "text", text });
}

function emitToolCallProgress(state: StreamState, events: StreamParserEvent[], tools: Tool[]): void {
	if (!state.isInsideToolCall || state.currentToolCallJson.length === 0) {
		return;
	}

	const progress = extractArgumentsProgress(state.currentToolCallJson);
	if (
		!progress.toolName ||
		!normalizeToolNames(tools).has(progress.toolName) ||
		!progress.argumentsText ||
		!progress.argumentsComplete
	) {
		return;
	}

	try {
		const parsedArguments = parseRelaxedJson(progress.argumentsText);
		if (!isRecord(parsedArguments)) {
			return;
		}

		if (!state.activeToolCall) {
			state.activeToolCall = {
				index: state.toolCallCount,
				id: createToolCallId(state.toolCallCount),
				name: progress.toolName,
				emittedArguments: "",
			};
			state.toolCallCount += 1;
			events.push({
				type: "toolcall_start",
				index: state.activeToolCall.index,
				name: state.activeToolCall.name,
				id: state.activeToolCall.id,
			});
		}

		const canonicalArguments = JSON.stringify(parsedArguments);
		if (!canonicalArguments.startsWith(state.activeToolCall.emittedArguments)) {
			state.activeToolCall.emittedArguments = "";
		}

		const argumentsDelta = canonicalArguments.slice(state.activeToolCall.emittedArguments.length);
		if (argumentsDelta.length === 0) {
			return;
		}

		state.activeToolCall.emittedArguments = canonicalArguments;
		events.push({
			type: "toolcall_delta",
			index: state.activeToolCall.index,
			argumentsDelta,
		});
	} catch {}
}

function finalizeToolCall(state: StreamState, events: StreamParserEvent[], tools: Tool[]): void {
	const fullSegment = `${TOOL_CALL_START}${state.currentToolCallJson}${TOOL_CALL_END}`;
	const parsedToolCall = parseToolCallJson(state.currentToolCallJson, tools);
	if (!parsedToolCall || !state.activeToolCall) {
		emitText(events, fullSegment);
		state.activeToolCall = null;
		state.currentToolCallJson = "";
		state.isInsideToolCall = false;
		return;
	}

	const canonicalArguments = JSON.stringify(parsedToolCall.arguments);
	if (canonicalArguments !== state.activeToolCall.emittedArguments) {
		const argumentsDelta = canonicalArguments.slice(state.activeToolCall.emittedArguments.length);
		if (argumentsDelta.length > 0) {
			events.push({
				type: "toolcall_delta",
				index: state.activeToolCall.index,
				argumentsDelta,
			});
		}
	}

	events.push({
		type: "toolcall_end",
		index: state.activeToolCall.index,
		name: parsedToolCall.name,
		id: state.activeToolCall.id,
		arguments: parsedToolCall.arguments,
	});

	state.activeToolCall = null;
	state.currentToolCallJson = "";
	state.isInsideToolCall = false;
}

function flushInsideToolCallBuffer(state: StreamState, events: StreamParserEvent[], tools: Tool[]): void {
	const potentialEndIndex = getPotentialStartIndex(state.buffer, TOOL_CALL_END);
	if (potentialEndIndex != null && potentialEndIndex + TOOL_CALL_END.length > state.buffer.length) {
		state.currentToolCallJson += state.buffer.slice(0, potentialEndIndex);
		state.buffer = state.buffer.slice(potentialEndIndex);
		emitToolCallProgress(state, events, tools);
		return;
	}

	state.currentToolCallJson += state.buffer;
	state.buffer = "";
	emitToolCallProgress(state, events, tools);
}

function flushOutsideToolCallBuffer(state: StreamState, events: StreamParserEvent[]): void {
	const potentialStartIndex = getPotentialStartIndex(state.buffer, TOOL_CALL_START);
	if (potentialStartIndex != null && potentialStartIndex + TOOL_CALL_START.length > state.buffer.length) {
		emitText(events, state.buffer.slice(0, potentialStartIndex));
		state.buffer = state.buffer.slice(potentialStartIndex);
		return;
	}

	emitText(events, state.buffer);
	state.buffer = "";
}

export function hermesParseGeneratedText(text: string, tools: Tool[]): ParsedToolCall[] {
	const parsedToolCalls: ParsedToolCall[] = [];
	const toolCallRegex = new RegExp(`${escapeRegExp(TOOL_CALL_START)}([\\s\\S]*?)${escapeRegExp(TOOL_CALL_END)}`, "g");

	let match = toolCallRegex.exec(text);
	while (match !== null) {
		const toolCallJson = match[1] ?? "";
		const parsedToolCall = parseToolCallJson(toolCallJson, tools);
		if (parsedToolCall) {
			parsedToolCalls.push(parsedToolCall);
		}
		match = toolCallRegex.exec(text);
	}

	return parsedToolCalls;
}

export function hermesCreateStreamParser(tools: Tool[]): StreamParser {
	const state: StreamState = {
		activeToolCall: null,
		buffer: "",
		currentToolCallJson: "",
		isInsideToolCall: false,
		toolCallCount: 0,
	};

	return {
		feed(textDelta: string): StreamParserEvent[] {
			const events: StreamParserEvent[] = [];
			state.buffer += textDelta;

			let nextTagIndex = getPotentialStartIndex(
				state.buffer,
				state.isInsideToolCall ? TOOL_CALL_END : TOOL_CALL_START,
			);

			while (nextTagIndex != null) {
				const currentTag = state.isInsideToolCall ? TOOL_CALL_END : TOOL_CALL_START;
				if (nextTagIndex + currentTag.length > state.buffer.length) {
					break;
				}

				if (state.isInsideToolCall) {
					state.currentToolCallJson += state.buffer.slice(0, nextTagIndex);
					state.buffer = state.buffer.slice(nextTagIndex + currentTag.length);
					emitToolCallProgress(state, events, tools);
					finalizeToolCall(state, events, tools);
				} else {
					emitText(events, state.buffer.slice(0, nextTagIndex));
					state.buffer = state.buffer.slice(nextTagIndex + currentTag.length);
					state.isInsideToolCall = true;
					state.currentToolCallJson = "";
					state.activeToolCall = null;
				}

				nextTagIndex = getPotentialStartIndex(
					state.buffer,
					state.isInsideToolCall ? TOOL_CALL_END : TOOL_CALL_START,
				);
			}

			if (state.isInsideToolCall) {
				flushInsideToolCallBuffer(state, events, tools);
			} else {
				flushOutsideToolCallBuffer(state, events);
			}

			return events;
		},
		finish(): StreamParserEvent[] {
			const events: StreamParserEvent[] = [];

			if (state.isInsideToolCall) {
				const unfinishedToolCall = `${TOOL_CALL_START}${state.currentToolCallJson}${state.buffer}`;
				emitText(events, unfinishedToolCall);
				state.activeToolCall = null;
				state.currentToolCallJson = "";
				state.isInsideToolCall = false;
				state.buffer = "";
				return events;
			}

			emitText(events, state.buffer);
			state.buffer = "";
			return events;
		},
	};
}
