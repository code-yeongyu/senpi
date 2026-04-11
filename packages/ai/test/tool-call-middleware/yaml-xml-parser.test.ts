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
});
