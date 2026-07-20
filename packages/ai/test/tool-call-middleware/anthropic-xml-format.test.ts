import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	anthropicXmlFormatToolCall,
	anthropicXmlFormatToolResponse,
	anthropicXmlFormatToolsSystemPrompt,
} from "../../src/tool-call-middleware/protocols/anthropic-xml/format.ts";
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

describe("anthropicXmlFormatToolsSystemPrompt", () => {
	it("renders JSON tool definitions and a bare invoke example", () => {
		// given
		const tools = [weatherTool];

		// when
		const prompt = anthropicXmlFormatToolsSystemPrompt(tools);
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
		expect(prompt).toContain('<invoke name="get_weather"><parameter name="city">Seoul</parameter></invoke>');
		expect(prompt).toContain("exactly one");
		expect(prompt).not.toContain("<function_calls>");
	});
});

describe("anthropicXmlFormatToolCall", () => {
	it("formats scalar values verbatim and nested values as compact JSON", () => {
		// given
		const args = {
			city: "Seoul",
			includeForecast: true,
			days: 2,
			filters: { temperature: "mild" },
			tags: ["today", "local"],
		};

		// when
		const formatted = anthropicXmlFormatToolCall("get_weather", args);

		// then
		expect(formatted).toBe(
			'<invoke name="get_weather">\n' +
				'<parameter name="city">Seoul</parameter>\n' +
				'<parameter name="includeForecast">true</parameter>\n' +
				'<parameter name="days">2</parameter>\n' +
				'<parameter name="filters">{"temperature":"mild"}</parameter>\n' +
				'<parameter name="tags">["today","local"]</parameter>\n' +
				"</invoke>",
		);
		expect(formatted).not.toContain("<function_calls>");
	});

	it("escapes XML-sensitive tool, parameter, and scalar values", () => {
		// given
		const args = { 'query<&"': '<unsafe> & "value"' };

		// when
		const formatted = anthropicXmlFormatToolCall('search<&"', args);

		// then
		expect(formatted).toBe(
			'<invoke name="search&lt;&amp;&quot;">\n' +
				'<parameter name="query&lt;&amp;&quot;">&lt;unsafe&gt; &amp; "value"</parameter>\n' +
				"</invoke>",
		);
	});
});

describe("anthropicXmlFormatToolResponse", () => {
	it("extracts text content into Anthropic-style function results", () => {
		// given
		const content: ToolResultContent[] = [
			{ type: "text", text: "first line" },
			{ type: "image", data: "ignored", mimeType: "image/png" },
			{ type: "text", text: "second line" },
		];

		// when
		const formatted = anthropicXmlFormatToolResponse("run_command", "call-1", content);

		// then
		expect(formatted).toBe(
			"<function_results>\n" +
				"<result>\n" +
				"<tool_name>run_command</tool_name>\n" +
				"<stdout>first line\nsecond line</stdout>\n" +
				"</result>\n" +
				"</function_results>",
		);
	});

	it("escapes XML-sensitive tool names and stdout content", () => {
		// given
		const content: ToolResultContent[] = [{ type: "text", text: 'line </stdout> & <result> "output"' }];

		// when
		const formatted = anthropicXmlFormatToolResponse('tool</tool_name>&"', "call-2", content);

		// then
		expect(formatted).toBe(
			"<function_results>\n" +
				"<result>\n" +
				'<tool_name>tool&lt;/tool_name&gt;&amp;"</tool_name>\n' +
				'<stdout>line &lt;/stdout&gt; &amp; &lt;result&gt; "output"</stdout>\n' +
				"</result>\n" +
				"</function_results>",
		);
	});
});
