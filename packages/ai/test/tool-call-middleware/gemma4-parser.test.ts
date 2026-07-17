import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
	gemma4CreateStreamParser,
	gemma4ParseGeneratedText,
	scanGemma4ArgsComplete,
} from "../../src/tool-call-middleware/protocols/gemma4.ts";
import type { Tool } from "../../src/types.ts";
import { FIXTURE_TOOLS, TRUNCATION_FIXTURES } from "./truncation-fixtures.ts";

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

describe("Gemma 4 truncation recovery", () => {
	it.each(TRUNCATION_FIXTURES["gemma4-delimiter"])("$title", (fixture) => {
		const onError = vi.fn();
		const parser = gemma4CreateStreamParser(FIXTURE_TOOLS, { onError });
		const events = [...parser.feed(fixture.input), ...parser.finish()];
		const toolCallEvents = events.filter((event) => event.type.startsWith("toolcall_"));
		const text = events
			.filter((event) => event.type === "text")
			.map((event) => event.text)
			.join("");

		switch (fixture.expected.kind) {
			case "recovered": {
				const ends = events.filter((event) => event.type === "toolcall_end");
				expect(ends).toHaveLength(1);
				expect(ends[0]).toMatchObject({
					name: fixture.tool,
					arguments: fixture.expected.arguments,
				});
				expect(ends[0]).not.toHaveProperty("incomplete");
				expect(text).not.toContain("<|tool_call>");
				break;
			}
			case "incomplete": {
				const ends = events.filter((event) => event.type === "toolcall_end");
				expect(ends).toHaveLength(1);
				expect(ends[0]).toMatchObject({ incomplete: true });
				expect(text).not.toContain("<|tool_call>");
				expect(JSON.stringify(onError.mock.calls)).not.toContain(fixture.input);
				break;
			}
			case "dropped":
				expect(toolCallEvents).toEqual([]);
				expect(text).not.toContain("<|tool_call>");
				expect(onError).toHaveBeenCalledOnce();
				expect(JSON.stringify(onError.mock.calls)).not.toContain(fixture.input);
				break;
			default:
				throw new Error(`Unexpected fixture kind: ${fixture.expected.kind}`);
		}
	});

	it("requires an explicit outer closing brace before recovering", () => {
		expect(scanGemma4ArgsComplete('get_weather{city:<|"|>Seoul<|"|>')).toBeNull();
		expect(scanGemma4ArgsComplete('get_weather{city:<|"|>Seoul<|"|>}')).toEqual({
			rawArgs: 'city:<|"|>Seoul<|"|>',
		});
	});

	it("flags a split string delimiter at EOF without leaking markup", () => {
		const parser = gemma4CreateStreamParser(FIXTURE_TOOLS);
		const events = [...parser.feed('<|tool_call>call:get_weather{city:<|"'), ...parser.finish()];

		expect(events).toContainEqual(
			expect.objectContaining({ type: "toolcall_end", incomplete: true, name: "get_weather" }),
		);
		expect(events).not.toContainEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining("<|tool_call>") }),
		);
	});

	it("recovers a partial terminator after balanced arguments", () => {
		const parser = gemma4CreateStreamParser(FIXTURE_TOOLS);
		const events = [...parser.feed('<|tool_call>call:get_weather{city:<|"|>Seoul<|"|>}<tool_c'), ...parser.finish()];

		expect(events).toContainEqual(
			expect.objectContaining({
				type: "toolcall_end",
				name: "get_weather",
				arguments: { city: "Seoul" },
			}),
		);
		expect(events).not.toContainEqual(expect.objectContaining({ type: "toolcall_end", incomplete: true }));
	});

	it("drops a terminated call with an unknown name", () => {
		const onError = vi.fn();
		const parser = gemma4CreateStreamParser(FIXTURE_TOOLS, { onError });
		const events = [
			...parser.feed('<|tool_call>call:unknown_tool{city:<|"|>Seoul<|"|>}<tool_call|>'),
			...parser.finish(),
		];

		expect(events).toEqual([]);
		expect(onError).toHaveBeenCalledOnce();
		expect(JSON.stringify(onError.mock.calls)).not.toContain("unknown_tool{city");
	});

	it("finishes a started truncated call exactly once with consistent ids", () => {
		const parser = gemma4CreateStreamParser(FIXTURE_TOOLS);
		const feedEvents = parser.feed('<|tool_call>call:get_weather{city:<|"|>Seo');
		const finishEvents = parser.finish();
		const allEvents = [...feedEvents, ...finishEvents];
		const start = allEvents.find((event) => event.type === "toolcall_start");
		const endEvents = allEvents.filter((event) => event.type === "toolcall_end");

		expect(start).toMatchObject({ type: "toolcall_start", id: "gemma4-tool-0" });
		expect(allEvents.some((event) => event.type === "toolcall_delta")).toBe(true);
		expect(endEvents).toEqual([
			expect.objectContaining({ type: "toolcall_end", id: "gemma4-tool-0", incomplete: true }),
		]);
	});

	it.each([
		["unbalanced arguments", 'call:get_weather{city:<|"|>Seo'],
		["arguments that fail validation", "call:get_weather{}"],
	])("reports sanitized metadata for incomplete known calls with %s", (_reason, rawFragment) => {
		const onError = vi.fn();
		const parser = gemma4CreateStreamParser(FIXTURE_TOOLS, { onError });
		const events = [...parser.feed(`<|tool_call>${rawFragment}`), ...parser.finish()];

		expect(events).toContainEqual(expect.objectContaining({ type: "toolcall_end", incomplete: true }));
		expect(onError).toHaveBeenCalledOnce();
		expect(onError).toHaveBeenCalledWith("Could not complete Gemma4 tool call at finish.", {
			protocol: "gemma4-delimiter",
			retainedLength: rawFragment.length,
		});
		expect(JSON.stringify(onError.mock.calls)).not.toContain(rawFragment);
	});
});
