import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { hermesCreateStreamParser, hermesParseGeneratedText } from "../../src/tool-call-middleware/protocols/hermes.js";
import type { Tool } from "../../src/types.js";

const weatherTool: Tool = {
	name: "get_weather",
	description: "Get weather for a location",
	parameters: Type.Object({
		city: Type.String(),
		unit: Type.Optional(Type.String()),
	}),
};

const clockTool: Tool = {
	name: "get_time",
	description: "Get time for a timezone",
	parameters: Type.Object({
		timezone: Type.String(),
	}),
};

describe("hermesParseGeneratedText", () => {
	it("parses a single tool call when hermes markup contains valid json", () => {
		// given
		const text = '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call>';

		// when
		const result = hermesParseGeneratedText(text, [weatherTool]);

		// then
		expect(result).toEqual([
			{
				name: "get_weather",
				arguments: {
					city: "Seoul",
				},
			},
		]);
	});

	it("parses multiple consecutive tool calls when several hermes blocks are present", () => {
		// given
		const text = [
			'<tool_call>{"name":"get_weather","arguments":{"city":"Seoul",}}</tool_call>',
			'<tool_call>{"name":"get_time","arguments":{"timezone":"Asia/Seoul"}}</tool_call>',
		].join("");

		// when
		const result = hermesParseGeneratedText(text, [weatherTool, clockTool]);

		// then
		expect(result).toEqual([
			{
				name: "get_weather",
				arguments: {
					city: "Seoul",
				},
			},
			{
				name: "get_time",
				arguments: {
					timezone: "Asia/Seoul",
				},
			},
		]);
	});

	it("ignores surrounding text when tool call is embedded between text segments", () => {
		// given
		const text = [
			"Before tool call. ",
			'<tool_call>{"name":"get_weather","arguments":{"city":"Busan"}}</tool_call>',
			" After tool call.",
		].join("");

		// when
		const result = hermesParseGeneratedText(text, [weatherTool]);

		// then
		expect(result).toEqual([
			{
				name: "get_weather",
				arguments: {
					city: "Busan",
				},
			},
		]);
	});

	it("skips malformed json gracefully when a hermes block cannot be parsed", () => {
		// given
		const text = '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"</tool_call>';

		// when
		const result = hermesParseGeneratedText(text, [weatherTool]);

		// then
		expect(result).toEqual([]);
	});
});

describe("hermesCreateStreamParser", () => {
	it("streams text and tool calls when text surrounds a valid tool call", () => {
		// given
		const parser = hermesCreateStreamParser([weatherTool]);

		// when
		const feedEvents = parser.feed(
			'Before <tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call> after',
		);
		const finishEvents = parser.finish();

		// then
		expect(feedEvents).toEqual([
			{ type: "text", text: "Before " },
			{ type: "toolcall_start", index: 0, name: "get_weather", id: "hermes-tool-0" },
			{ type: "toolcall_delta", index: 0, argumentsDelta: '{"city":"Seoul"}' },
			{
				type: "toolcall_end",
				index: 0,
				name: "get_weather",
				id: "hermes-tool-0",
				arguments: {
					city: "Seoul",
				},
			},
			{ type: "text", text: " after" },
		]);
		expect(finishEvents).toEqual([]);
	});

	it("handles tool call start tag split across streaming chunk boundaries", () => {
		// given
		const parser = hermesCreateStreamParser([weatherTool]);

		// when
		const firstEvents = parser.feed("prefix <tool");
		const secondEvents = parser.feed('_call>{"name":"get_weather","arguments":{"city":"Seoul"}}');
		const thirdEvents = parser.feed("</tool_call> suffix");
		const finishEvents = parser.finish();

		// then
		expect(firstEvents).toEqual([{ type: "text", text: "prefix " }]);
		expect(secondEvents).toEqual([
			{ type: "toolcall_start", index: 0, name: "get_weather", id: "hermes-tool-0" },
			{ type: "toolcall_delta", index: 0, argumentsDelta: '{"city":"Seoul"}' },
		]);
		expect(thirdEvents).toEqual([
			{
				type: "toolcall_end",
				index: 0,
				name: "get_weather",
				id: "hermes-tool-0",
				arguments: {
					city: "Seoul",
				},
			},
			{ type: "text", text: " suffix" },
		]);
		expect(finishEvents).toEqual([]);
	});

	it("emits malformed hermes tool call markup as text when json is invalid", () => {
		// given
		const parser = hermesCreateStreamParser([weatherTool]);

		// when
		const feedEvents = parser.feed(
			'prefix <tool_call>{"name":"get_weather","arguments":{"city":"Seoul"</tool_call> suffix',
		);
		const finishEvents = parser.finish();

		// then
		expect(feedEvents).toEqual([
			{ type: "text", text: "prefix " },
			{
				type: "text",
				text: '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"</tool_call>',
			},
			{ type: "text", text: " suffix" },
		]);
		expect(finishEvents).toEqual([]);
	});
});
