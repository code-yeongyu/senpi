import YAML from "yaml";
import type { TextContent, Tool } from "../../types.js";
import type { ParsedToolCall, StreamParser, StreamParserEvent } from "../types.js";
import { findEarliestXmlToolTag, findSelfClosingToolTag, getSafeXmlTextLength } from "./xml-tool-tag-scanner.js";

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeYamlContent(yamlContent: string): string {
	const trimmedLeadingNewline = yamlContent.startsWith("\n") ? yamlContent.slice(1) : yamlContent;
	const lines = trimmedLeadingNewline.split("\n");
	const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
	if (nonEmptyLines.length === 0) {
		return "";
	}

	const minIndent = Math.min(
		...nonEmptyLines.map((line) => {
			const match = line.match(/^(\s*)/);
			return match?.[1].length ?? 0;
		}),
	);
	return minIndent > 0 ? lines.map((line) => line.slice(minIndent)).join("\n") : trimmedLeadingNewline;
}

function parseYamlMapping(yamlContent: string): Record<string, unknown> | null {
	const normalized = normalizeYamlContent(yamlContent);
	if (normalized.trim().length === 0) {
		return {};
	}

	try {
		const parsed = YAML.parse(normalized) as unknown;
		if (parsed === null) {
			return {};
		}
		if (typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

export function yamlXmlFormatToolsSystemPrompt(tools: Tool[]): string {
	if (tools.length === 0) {
		return "";
	}

	const toolsRendered = JSON.stringify(
		tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		})),
	);

	return `# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>${toolsRendered}</tools>

# Format

Use exactly one XML element whose tag name is the function name.
Inside the XML element, specify parameters using YAML syntax (key: value pairs).

# Example
<get_weather>
city: Seoul
unit: celsius
</get_weather>`;
}

export function yamlXmlFormatToolCall(name: string, args: Record<string, unknown>): string {
	const yamlBody = YAML.stringify(args).trimEnd();
	return `<${name}>\n${yamlBody.length > 0 ? yamlBody : "null"}\n</${name}>`;
}

export function yamlXmlFormatToolResponse(toolName: string, _toolCallId: string, content: TextContent[]): string {
	const textContent = content
		.filter((entry): entry is TextContent => entry.type === "text")
		.map((entry) => entry.text)
		.join("\n");

	return [
		`<tool_response>`,
		`tool_name: ${toolName}`,
		`result: |-`,
		...textContent.split("\n").map((line) => `  ${line}`),
		`</tool_response>`,
	].join("\n");
}

export function parseYamlXmlGeneratedText(text: string, tools: Tool[]): ParsedToolCall[] {
	if (tools.length === 0 || text.length === 0) {
		return [];
	}

	const toolNames = tools.map((tool) => tool.name);
	const parsedToolCalls: ParsedToolCall[] = [];

	for (const toolName of toolNames) {
		let selfClosingMatch = findSelfClosingToolTag(text, toolName, 0);
		while (selfClosingMatch) {
			parsedToolCalls.push({ name: toolName, arguments: {} });
			selfClosingMatch = findSelfClosingToolTag(text, toolName, selfClosingMatch.index + selfClosingMatch.length);
		}

		const toolCallRegex = new RegExp(
			`<\\s*${escapeRegExp(toolName)}\\s*>([\\s\\S]*?)<\\/\\s*${escapeRegExp(toolName)}\\s*>`,
			"g",
		);
		for (const match of text.matchAll(toolCallRegex)) {
			const yamlContent = match[1] ?? "";
			const parsedArguments = parseYamlMapping(yamlContent);
			if (parsedArguments === null) {
				continue;
			}
			parsedToolCalls.push({
				name: toolName,
				arguments: parsedArguments,
			});
		}
	}

	return parsedToolCalls;
}

export function createYamlXmlStreamParser(tools: Tool[]): StreamParser {
	const toolNames = tools.map((tool) => tool.name);
	let buffer = "";
	let currentToolState: {
		id: string;
		index: number;
		name: string;
		lastArgumentsSnapshot: string | null;
	} | null = null;
	let nextToolCallIndex = 0;

	function emitSnapshot(events: StreamParserEvent[], yamlContent: string): void {
		if (!currentToolState) {
			return;
		}
		const parsedArguments = parseYamlMapping(yamlContent);
		if (parsedArguments === null) {
			return;
		}

		const snapshot = JSON.stringify(parsedArguments);
		if (snapshot === "{}" || snapshot === currentToolState.lastArgumentsSnapshot) {
			return;
		}

		if (currentToolState.lastArgumentsSnapshot === null) {
			events.push({
				type: "toolcall_start",
				index: currentToolState.index,
				name: currentToolState.name,
				id: currentToolState.id,
			});
		}

		currentToolState.lastArgumentsSnapshot = snapshot;
		events.push({
			type: "toolcall_delta",
			index: currentToolState.index,
			argumentsDelta: snapshot,
		});
	}

	function processBuffer(): StreamParserEvent[] {
		const events: StreamParserEvent[] = [];

		while (buffer.length > 0) {
			if (currentToolState) {
				const closingTagRegex = new RegExp(`</\\s*${escapeRegExp(currentToolState.name)}\\s*>`);
				const closingTagMatch = closingTagRegex.exec(buffer);
				if (!closingTagMatch || closingTagMatch.index === undefined) {
					emitSnapshot(events, buffer);
					break;
				}

				const yamlContent = buffer.slice(0, closingTagMatch.index);
				const originalCallText = `<${currentToolState.name}>${yamlContent}${closingTagMatch[0]}`;
				const parsedArguments = parseYamlMapping(yamlContent);
				buffer = buffer.slice(closingTagMatch.index + closingTagMatch[0].length);
				if (parsedArguments === null) {
					events.push({ type: "text", text: originalCallText });
					currentToolState = null;
					continue;
				}

				emitSnapshot(events, yamlContent);
				if (currentToolState.lastArgumentsSnapshot === null) {
					events.push({
						type: "toolcall_start",
						index: currentToolState.index,
						name: currentToolState.name,
						id: currentToolState.id,
					});
				}
				events.push({
					type: "toolcall_end",
					index: currentToolState.index,
					name: currentToolState.name,
					id: currentToolState.id,
					arguments: parsedArguments,
				});
				currentToolState = null;
				continue;
			}

			const openingTag = findEarliestXmlToolTag(buffer, toolNames);
			if (!openingTag) {
				const textLength = getSafeXmlTextLength(buffer, toolNames);
				if (textLength === 0) {
					break;
				}
				events.push({ type: "text", text: buffer.slice(0, textLength) });
				buffer = buffer.slice(textLength);
				continue;
			}

			if (openingTag.index > 0) {
				events.push({ type: "text", text: buffer.slice(0, openingTag.index) });
			}

			buffer = buffer.slice(openingTag.index + openingTag.tag.length);
			if (openingTag.selfClosing) {
				const id = `yaml-xml-tool-${nextToolCallIndex}`;
				const index = nextToolCallIndex;
				nextToolCallIndex += 1;
				events.push({ type: "toolcall_start", index, name: openingTag.name, id });
				events.push({ type: "toolcall_end", index, name: openingTag.name, id, arguments: {} });
				continue;
			}

			currentToolState = {
				id: `yaml-xml-tool-${nextToolCallIndex}`,
				index: nextToolCallIndex,
				name: openingTag.name,
				lastArgumentsSnapshot: null,
			};
			nextToolCallIndex += 1;
		}

		return events;
	}

	return {
		feed(textDelta: string): StreamParserEvent[] {
			if (textDelta.length === 0) {
				return [];
			}
			buffer += textDelta;
			return processBuffer();
		},
		finish(): StreamParserEvent[] {
			const events = processBuffer();
			if (!currentToolState && buffer.length > 0) {
				events.push({ type: "text", text: buffer });
				buffer = "";
			}
			if (currentToolState && buffer.length > 0) {
				events.push({ type: "text", text: `<${currentToolState.name}>${buffer}` });
				buffer = "";
				currentToolState = null;
			}
			return events;
		},
	};
}
