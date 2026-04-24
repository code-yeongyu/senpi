import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { gemma4CreateStreamParser, gemma4ParseGeneratedText } from "../../src/tool-call-middleware/protocols/gemma4.js";
import type { Tool } from "../../src/types.js";

const weatherTool: Tool = {
	name: "get_weather",
	description: "Get weather for a city",
	parameters: Type.Object({
		city: Type.String(),
		count: Type.Optional(Type.Number()),
		flag: Type.Optional(Type.Boolean()),
	}),
};

const searchTool: Tool = {
	name: "search_catalog",
	description: "Search a nested catalog",
	parameters: Type.Object({
		filters: Type.Object({
			category: Type.String(),
			price: Type.Object({
				min: Type.Number(),
				max: Type.Number(),
			}),
		}),
		tags: Type.Array(Type.String()),
	}),
};

describe("gemma4ParseGeneratedText", () => {
	it("parses a single Gemma 4 tool call with string delimiters", () => {
		// given
		const text = '<|tool_call>call:get_weather{city:<|"|>Seoul<|"|>}<tool_call|>';

		// when
		const result = gemma4ParseGeneratedText(text, [weatherTool]);

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

	it("parses bare numbers and booleans with their native types", () => {
		// given
		const text = "<|tool_call>call:get_weather{count:42,flag:true}<tool_call|>";

		// when
		const result = gemma4ParseGeneratedText(text, [weatherTool]);

		// then
		expect(result).toEqual([
			{
				name: "get_weather",
				arguments: {
					count: 42,
					flag: true,
				},
			},
		]);
	});

	it("parses nested objects and arrays in Gemma 4 argument syntax", () => {
		// given
		const text = [
			"<|tool_call>call:search_catalog{",
			'filters:{category:<|"|>books<|"|>,price:{min:10,max:20}},',
			'tags:[<|"|>fiction<|"|>,<|"|>award<|"|>]',
			"}<tool_call|>",
		].join("");

		// when
		const result = gemma4ParseGeneratedText(text, [searchTool]);

		// then
		expect(result).toEqual([
			{
				name: "search_catalog",
				arguments: {
					filters: {
						category: "books",
						price: {
							min: 10,
							max: 20,
						},
					},
					tags: ["fiction", "award"],
				},
			},
		]);
	});

	it("parses tool calls between text segments and accepts the <turn|> fallback end tag", () => {
		// given
		const text = [
			"Before tool call. ",
			'<|tool_call>call:get_weather{city:<|"|>Seoul<|"|>}<turn|>',
			" After tool call.",
		].join("");

		// when
		const result = gemma4ParseGeneratedText(text, [weatherTool]);

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
});

describe("gemma4CreateStreamParser", () => {
	it("streams Gemma 4 tool calls with accumulate-parse-diff and split special tokens", () => {
		// given
		const parser = gemma4CreateStreamParser([weatherTool]);

		// when
		const firstEvents = parser.feed("Before <|tool");
		const secondEvents = parser.feed('_call>call:get_weather{city:<|"|>Seo');
		const thirdEvents = parser.feed('ul<|"|>,count:4');
		const fourthEvents = parser.feed("2,flag:true}<tool_");
		const fifthEvents = parser.feed("call|> after");
		const finishEvents = parser.finish();

		// then
		expect(firstEvents).toEqual([{ type: "text", text: "Before " }]);
		expect(secondEvents).toEqual([
			{ type: "toolcall_start", index: 0, name: "get_weather", id: "gemma4-tool-0" },
			{ type: "toolcall_delta", index: 0, argumentsDelta: '{"city":"Seo' },
		]);
		expect(thirdEvents).toEqual([{ type: "toolcall_delta", index: 0, argumentsDelta: "ul" }]);
		expect(fourthEvents).toEqual([{ type: "toolcall_delta", index: 0, argumentsDelta: '","count":42' }]);
		expect(fifthEvents).toEqual([
			{ type: "toolcall_delta", index: 0, argumentsDelta: ',"flag":true}' },
			{
				type: "toolcall_end",
				index: 0,
				name: "get_weather",
				id: "gemma4-tool-0",
				arguments: {
					city: "Seoul",
					count: 42,
					flag: true,
				},
			},
			{ type: "text", text: " after" },
		]);
		expect(finishEvents).toEqual([]);
	});
});
