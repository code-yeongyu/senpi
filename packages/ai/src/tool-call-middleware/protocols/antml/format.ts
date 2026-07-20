import type { Tool } from "../../../types.ts";
import type { ToolResultContent } from "../../types.ts";
import {
	anthropicXmlFormatToolCall,
	anthropicXmlFormatToolResponse,
	renderToolDefinitions,
} from "../anthropic-xml/format.ts";

export function antmlFormatToolsSystemPrompt(tools: Tool[]): string {
	if (tools.length === 0) {
		return "";
	}

	return `# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures as JSON within <tools></tools> XML tags:
<tools>${renderToolDefinitions(tools)}</tools>

# Format

Emit every tool call inside one <function_calls> block.
For each function call, emit one <invoke> element with the tool name in its name attribute.
Put each argument in one <parameter> element with its name in the name attribute.
String and scalar parameters are written as-is; arrays and objects are written as JSON.

# Example
<function_calls>
<invoke name="get_weather">
<parameter name="city">Seoul</parameter>
</invoke>
</function_calls>`;
}

export function antmlFormatToolCall(name: string, args: Record<string, unknown>): string {
	return ["<function_calls>", anthropicXmlFormatToolCall(name, args), "</function_calls>"].join("\n");
}

export function antmlFormatToolResponse(toolName: string, toolCallId: string, content: ToolResultContent[]): string {
	return anthropicXmlFormatToolResponse(toolName, toolCallId, content);
}
