import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
	createYamlXmlStreamParser,
	parseYamlXmlGeneratedText,
	yamlXmlFormatToolCall,
} from "../../src/tool-call-middleware/protocols/yaml-xml.js";
import type { Tool } from "../../src/types.js";

const weatherTool: Tool = {
	name: "get_weather",
	description: "Get weather for a location",
	parameters: Type.Object({
		city: Type.String(),
		unit: Type.Optional(Type.String()),
	}),
};

const writeFileTool: Tool = {
	name: "write_file",
	description: "Write a file",
	parameters: Type.Object({
		file_path: Type.String(),
		contents: Type.String(),
	}),
};

describe("yamlXmlFormatToolCall", () => {
	it("formats object arguments as yaml inside an xml tag", () => {
		// given
		const args = { city: "Seoul", unit: "celsius" };

		// when
		const formatted = yamlXmlFormatToolCall("get_weather", args);

		// then
		expect(formatted).toContain("<get_weather>");
		expect(formatted).toContain("city: Seoul");
		expect(formatted).toContain("unit: celsius");
		expect(formatted).toContain("</get_weather>");
	});
});

describe("parseYamlXmlGeneratedText", () => {
	it("parses a yaml mapping wrapped in an xml tool tag", () => {
		// given
		const text = "<get_weather>\ncity: Seoul\nunit: celsius\n</get_weather>";

		// when
		const parsedToolCalls = parseYamlXmlGeneratedText(text, [weatherTool]);

		// then
		expect(parsedToolCalls).toEqual([
			{
				name: "get_weather",
				arguments: {
					city: "Seoul",
					unit: "celsius",
				},
			},
		]);
	});

	it("parses yaml multiline blocks", () => {
		// given
		const text = "<write_file>\nfile_path: /tmp/example.txt\ncontents: |\n  First line\n  Second line\n</write_file>";

		// when
		const parsedToolCalls = parseYamlXmlGeneratedText(text, [writeFileTool]);

		// then
		expect(parsedToolCalls).toEqual([
			{
				name: "write_file",
				arguments: {
					file_path: "/tmp/example.txt",
					contents: "First line\nSecond line\n",
				},
			},
		]);
	});

	it("treats self-closing tags as empty argument objects", () => {
		// given
		const text = "<get_weather />";

		// when
		const parsedToolCalls = parseYamlXmlGeneratedText(text, [weatherTool]);

		// then
		expect(parsedToolCalls).toEqual([
			{
				name: "get_weather",
				arguments: {},
			},
		]);
	});

	it("parses self-closing tags with surrounding text", () => {
		// given
		const text = "Getting your location now... <get_location/> Done!";

		// when
		const parsedToolCalls = parseYamlXmlGeneratedText(text, [
			{
				name: "get_location",
				description: "Get location",
				parameters: Type.Object({}),
			},
		]);

		// then
		expect(parsedToolCalls).toEqual([
			{
				name: "get_location",
				arguments: {},
			},
		]);
	});

	it("does not parse tool tags that appear inside a yaml block scalar body", () => {
		// given
		const writeFile = {
			name: "write_file",
			description: "Write file",
			parameters: Type.Object({
				file_path: Type.String(),
				contents: Type.String(),
			}),
		} satisfies Tool;
		const getLocation = {
			name: "get_location",
			description: "Get location",
			parameters: Type.Object({}),
		} satisfies Tool;
		const text = `<write_file>
file_path: /tmp/test.txt
contents: |
  The text contains <get_location/> tag
</write_file>`;

		// when
		const parsedToolCalls = parseYamlXmlGeneratedText(text, [writeFile, getLocation]);

		// then
		expect(parsedToolCalls).toEqual([
			{
				name: "write_file",
				arguments: {
					file_path: "/tmp/test.txt",
					contents: "The text contains <get_location/> tag\n",
				},
			},
		]);
	});

	it("parses multiple tool calls where the second starts after the first ends", () => {
		// given
		const writeFile = {
			name: "write_file",
			description: "Write file",
			parameters: Type.Object({
				file_path: Type.String(),
				contents: Type.String(),
			}),
		} satisfies Tool;
		const text = `<write_file>
file_path: test.txt
contents: normal content
</write_file>
<get_weather>
location: Seoul
</get_weather>`;

		// when
		const parsedToolCalls = parseYamlXmlGeneratedText(text, [writeFile, weatherTool]);

		// then
		expect(parsedToolCalls).toEqual([
			{
				name: "write_file",
				arguments: {
					file_path: "test.txt",
					contents: "normal content",
				},
			},
			{
				name: "get_weather",
				arguments: {
					location: "Seoul",
				},
			},
		]);
	});
});

describe("createYamlXmlStreamParser", () => {
	it("emits toolcall events when a yaml xml call completes", () => {
		// given
		const parser = createYamlXmlStreamParser([weatherTool]);

		// when
		const allEvents = [...parser.feed("<get_weather>\ncity: Seoul\n</get_weather>"), ...parser.finish()];

		// then
		expect(allEvents).toEqual([
			{ type: "toolcall_start", index: 0, name: "get_weather", id: "yaml-xml-tool-0" },
			{ type: "toolcall_delta", index: 0, argumentsDelta: '{"city":"Seoul"}' },
			{
				type: "toolcall_end",
				index: 0,
				name: "get_weather",
				id: "yaml-xml-tool-0",
				arguments: {
					city: "Seoul",
				},
			},
		]);
	});

	it("parses self-closing tags with surrounding text in the stream", () => {
		// given
		const parser = createYamlXmlStreamParser([
			{
				name: "get_location",
				description: "Get location",
				parameters: Type.Object({}),
			},
		]);

		// when
		const allEvents = [...parser.feed("prefix <get_location /> suffix"), ...parser.finish()];

		// then
		expect(allEvents).toEqual([
			{ type: "text", text: "prefix " },
			{ type: "toolcall_start", index: 0, name: "get_location", id: "yaml-xml-tool-0" },
			{ type: "toolcall_end", index: 0, name: "get_location", id: "yaml-xml-tool-0", arguments: {} },
			{ type: "text", text: " suffix" },
		]);
	});

	it("parses tool calls split across multiple chunks", () => {
		// given
		const parser = createYamlXmlStreamParser([weatherTool]);
		const chunks = ["<get_wea", "ther>\n", "location: Ber", "lin\n", "</get_weather>"];
		const events = [];

		// when
		for (const chunk of chunks) {
			events.push(...parser.feed(chunk));
		}
		events.push(...parser.finish());

		// then
		const toolcallEnd = events.find((event) => event.type === "toolcall_end");
		expect(toolcallEnd).toMatchObject({
			type: "toolcall_end",
			name: "get_weather",
			arguments: {
				location: "Berlin",
			},
		});
	});

	it("parses self-closing tags split across multiple chunks", () => {
		// given
		const parser = createYamlXmlStreamParser([
			{
				name: "get_location",
				description: "Get location",
				parameters: Type.Object({}),
			},
		]);

		// when
		const allEvents = [...parser.feed("<get_loca"), ...parser.feed("tion/>"), ...parser.finish()];

		// then
		expect(allEvents).toEqual([
			{ type: "toolcall_start", index: 0, name: "get_location", id: "yaml-xml-tool-0" },
			{ type: "toolcall_end", index: 0, name: "get_location", id: "yaml-xml-tool-0", arguments: {} },
		]);
	});

	it("parses multiline yaml values split across multiple chunks", () => {
		// given
		const writeFile = {
			name: "write_file",
			description: "Write file",
			parameters: Type.Object({
				file_path: Type.String(),
				contents: Type.String(),
			}),
		} satisfies Tool;
		const parser = createYamlXmlStreamParser([writeFile]);
		const chunks = [
			"<write_file>\n",
			"file_path: /tmp/test.txt\n",
			"contents: |\n",
			"  Line one\n",
			"  Line two\n",
			"</write_file>",
		];
		const events = [];

		// when
		for (const chunk of chunks) {
			events.push(...parser.feed(chunk));
		}
		events.push(...parser.finish());

		// then
		const toolcallEnd = events.find((event) => event.type === "toolcall_end");
		expect(toolcallEnd).toMatchObject({
			type: "toolcall_end",
			name: "write_file",
			arguments: {
				file_path: "/tmp/test.txt",
				contents: "Line one\nLine two\n",
			},
		});
	});
});
