import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	antmlFormatToolCall,
	antmlFormatToolResponse,
	antmlFormatToolsSystemPrompt,
} from "../../src/tool-call-middleware/protocols/antml/format.ts";
import type { ToolResultContent } from "../../src/tool-call-middleware/types.ts";
import type { Tool } from "../../src/types.ts";

const weatherTool: Tool = {
	name: "get_weather",
	description: "Get weather for a city",
	parameters: Type.Object({
		city: Type.String(),
		unit: Type.Optional(Type.String()),
	}),
};

describe("antmlFormatToolsSystemPrompt", () => {
	it("renders JSON tool definitions and a function_calls-wrapped example", () => {
		// given
		const tools = [weatherTool];

		// when
		const prompt = antmlFormatToolsSystemPrompt(tools);
		const toolsStart = prompt.lastIndexOf("<tools>") + "<tools>".length;
		const toolsEnd = prompt.lastIndexOf("</tools>");

		// then
		expect(JSON.parse(prompt.slice(toolsStart, toolsEnd))).toEqual([
			{
				name: weatherTool.name,
				description: weatherTool.description,
				parameters: weatherTool.parameters,
			},
		]);
		expect(prompt).toContain("<function_calls>");
		expect(prompt).toContain('<invoke name="get_weather">');
		expect(prompt).toContain("</function_calls>");
	});

	it("returns an empty prompt without tools", () => {
		// when / then
		expect(antmlFormatToolsSystemPrompt([])).toBe("");
	});
});

describe("antmlFormatToolCall", () => {
	it("wraps the canonical invoke serialization in a function_calls block", () => {
		// given
		const args = { city: "Seoul", tags: ["today", "local"] };

		// when
		const formatted = antmlFormatToolCall("get_weather", args);

		// then
		expect(formatted).toBe(
			"<function_calls>\n" +
				'<invoke name="get_weather">\n' +
				'<parameter name="city">Seoul</parameter>\n' +
				'<parameter name="tags">["today","local"]</parameter>\n' +
				"</invoke>\n" +
				"</function_calls>",
		);
	});
});

describe("antmlFormatToolResponse", () => {
	it("formats tool output as Anthropic-style function results", () => {
		// given
		const content: ToolResultContent[] = [{ type: "text", text: "sunny" }];

		// when
		const formatted = antmlFormatToolResponse("get_weather", "call-1", content);

		// then
		expect(formatted).toBe(
			"<function_results>\n" +
				"<result>\n" +
				"<tool_name>get_weather</tool_name>\n" +
				"<stdout>sunny</stdout>\n" +
				"</result>\n" +
				"</function_results>",
		);
	});
});
