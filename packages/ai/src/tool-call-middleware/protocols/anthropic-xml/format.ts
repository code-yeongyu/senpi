import type { Tool } from "../../../types.ts";
import type { ToolResultContent } from "../../types.ts";
import { encodeXmlAttribute, encodeXmlParameterText, encodeXmlText } from "./xml-entities.ts";

function serializeToolValue(value: unknown): string {
	if (typeof value === "object" && value !== null) {
		return JSON.stringify(value) ?? "null";
	}

	return String(value);
}

export function renderToolDefinitions(tools: Tool[]): string {
	const json = JSON.stringify(
		tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		})),
	);

	return json.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

export function anthropicXmlFormatToolsSystemPrompt(tools: Tool[]): string {
	if (tools.length === 0) {
		return "";
	}

	return `# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures as JSON within <tools></tools> XML tags:
<tools>${renderToolDefinitions(tools)}</tools>

# Format

For each function call, emit exactly one bare <invoke> element with the tool name in its name attribute.
Put each argument in one <parameter> element with its name in the name attribute.
Do not wrap the invoke element in another XML element.

# Example
<invoke name="get_weather"><parameter name="city">Seoul</parameter></invoke>`;
}

export function anthropicXmlFormatToolCall(name: string, args: Record<string, unknown>): string {
	const parameters = Object.entries(args).map(
		([parameterName, value]) =>
			`<parameter name="${encodeXmlAttribute(parameterName)}">${encodeXmlParameterText(serializeToolValue(value))}</parameter>`,
	);

	return [`<invoke name="${encodeXmlAttribute(name)}">`, ...parameters, "</invoke>"].join("\n");
}

export function anthropicXmlFormatToolResponse(
	toolName: string,
	_toolCallId: string,
	content: ToolResultContent[],
): string {
	const textContent = content
		.filter((entry): entry is Extract<ToolResultContent, { type: "text" }> => entry.type === "text")
		.map((entry) => entry.text)
		.join("\n");

	return [
		"<function_results>",
		"<result>",
		`<tool_name>${encodeXmlText(toolName)}</tool_name>`,
		`<stdout>${encodeXmlText(textContent)}</stdout>`,
		"</result>",
		"</function_results>",
	].join("\n");
}
