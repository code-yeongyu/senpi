import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { hermesCreateStreamParser, hermesParseGeneratedText } from "../../src/tool-call-middleware/protocols/hermes.ts";
import type { Tool } from "../../src/types.ts";
import { FIXTURE_TOOLS, TRUNCATION_FIXTURES } from "./truncation-fixtures.ts";

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

	it("reports malformed json parse failures through onError", () => {
		// given
		const onError = vi.fn();
		const text = "before <tool_call>{invalid}</tool_call> after";

		// when
		const result = hermesParseGeneratedText(text, [weatherTool], { onError });

		// then
		expect(result).toEqual([]);
		expect(onError).toHaveBeenCalled();
	});

	it("recovers common qwen-style malformed tool call json", () => {
		// given
		const text = '<tool_call>\n"name\': "read", "arguments": {"path": "/tmp/example.txt"}}\n</tool_call>';

		// when
		const result = hermesParseGeneratedText(text, [
			{
				name: "read",
				description: "Read a file",
				parameters: Type.Object({
					path: Type.String(),
				}),
			},
		]);

		// then
		expect(result).toEqual([
			{
				name: "read",
				arguments: {
					path: "/tmp/example.txt",
				},
			},
		]);
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

	it("handles tool call end tag split across streaming chunk boundaries", () => {
		// given
		const parser = hermesCreateStreamParser([weatherTool]);

		// when
		const firstEvents = parser.feed('<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool');
		const secondEvents = parser.feed("_call> suffix");
		const finishEvents = parser.finish();

		// then
		expect(firstEvents).toEqual([
			{ type: "toolcall_start", index: 0, name: "get_weather", id: "hermes-tool-0" },
			{ type: "toolcall_delta", index: 0, argumentsDelta: '{"city":"Seoul"}' },
		]);
		expect(secondEvents).toEqual([
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

	it("emits malformed hermes tool call markup as text when json is invalid and raw fallback is enabled", () => {
		// given
		const parser = hermesCreateStreamParser([weatherTool], { emitRawToolCallTextOnError: true });

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

	it("suppresses malformed hermes tool markup by default and reports onError", () => {
		// given
		const onError = vi.fn();
		const parser = hermesCreateStreamParser([weatherTool], { onError });

		// when
		const feedEvents = parser.feed(
			'prefix <tool_call>{"name":"get_weather","arguments":{"city":"Seoul"</tool_call> suffix',
		);
		const finishEvents = parser.finish();

		// then
		expect(feedEvents).toEqual([
			{ type: "text", text: "prefix " },
			{ type: "text", text: " suffix" },
		]);
		expect(finishEvents).toEqual([]);
		expect(onError).toHaveBeenCalled();
	});

	it("emits malformed hermes tool markup when raw fallback is explicitly enabled", () => {
		// given
		const parser = hermesCreateStreamParser([weatherTool], { emitRawToolCallTextOnError: true });

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

	it("flags unfinished hermes tool markup at finish by default", () => {
		// given
		const onError = vi.fn();
		const parser = hermesCreateStreamParser([weatherTool], { onError });

		// when
		const feedEvents = parser.feed('prefix <tool_call>{"name":"get_weather"');
		const finishEvents = parser.finish();

		// then
		expect(feedEvents).toEqual([{ type: "text", text: "prefix " }]);
		expect(finishEvents).toEqual([
			{ type: "toolcall_start", index: 0, name: "get_weather", id: "hermes-tool-0" },
			{
				type: "toolcall_end",
				index: 0,
				name: "get_weather",
				id: "hermes-tool-0",
				arguments: {},
				incomplete: true,
				errorMessage: "Tool call was truncated mid-arguments",
			},
		]);
		expect(onError).toHaveBeenCalledWith("Could not complete streaming JSON tool call at finish.", {
			protocol: "hermes",
			retainedLength: '{"name":"get_weather"'.length,
		});
	});

	it("never emits unfinished hermes markup at finish when raw fallback is enabled", () => {
		// given
		const parser = hermesCreateStreamParser([weatherTool], { emitRawToolCallTextOnError: true });

		// when
		const feedEvents = parser.feed('prefix <tool_call>{"name":"get_weather"');
		const finishEvents = parser.finish();

		// then
		expect(feedEvents).toEqual([{ type: "text", text: "prefix " }]);
		expect(finishEvents).toEqual([
			{ type: "toolcall_start", index: 0, name: "get_weather", id: "hermes-tool-0" },
			{
				type: "toolcall_end",
				index: 0,
				name: "get_weather",
				id: "hermes-tool-0",
				arguments: {},
				incomplete: true,
				errorMessage: "Tool call was truncated mid-arguments",
			},
		]);
	});

	it.each(TRUNCATION_FIXTURES.hermes)("recovers or flags $title", (fixture) => {
		// given
		const onError = vi.fn();
		const parser = hermesCreateStreamParser(FIXTURE_TOOLS, {
			onError,
			emitRawToolCallTextOnError: true,
		});

		// when
		const events = [...parser.feed(fixture.input), ...parser.finish()];
		const toolCallEvents = events.filter((event) => event.type.startsWith("toolcall_"));
		const text = events
			.filter((event) => event.type === "text")
			.map((event) => event.text)
			.join("");

		// then
		if (fixture.expected.kind === "recovered") {
			const ends = events.filter((event) => event.type === "toolcall_end");
			expect(ends).toHaveLength(1);
			expect(ends[0]).toMatchObject({
				type: "toolcall_end",
				name: fixture.tool,
				arguments: fixture.expected.arguments,
			});
			expect(ends[0]).not.toHaveProperty("incomplete");
			return;
		}

		if (fixture.expected.kind === "incomplete") {
			const ends = events.filter((event) => event.type === "toolcall_end");
			expect(ends).toHaveLength(1);
			expect(ends[0]).toMatchObject({ type: "toolcall_end", name: fixture.tool, incomplete: true });
			expect(text).not.toContain("<tool_call>");
			expect(onError).toHaveBeenCalled();
			expect(JSON.stringify(onError.mock.calls)).not.toContain(fixture.input);
			return;
		}

		expect(toolCallEvents).toEqual([]);
		expect(text).not.toContain(fixture.input);
		expect(onError).toHaveBeenCalled();
		expect(JSON.stringify(onError.mock.calls)).not.toContain(fixture.input);
	});

	it.each([false, true])("keeps unknown truncated names as raw text only when raw fallback is %s", (enabled) => {
		// given
		const onError = vi.fn();
		const input = '<tool_call>{"name":"unknown_tool","arguments":{"city":"Seoul"}}';
		const parser = hermesCreateStreamParser(FIXTURE_TOOLS, { onError, emitRawToolCallTextOnError: enabled });

		// when
		const events = [...parser.feed(input), ...parser.finish()];

		// then
		expect(events.filter((event) => event.type.startsWith("toolcall_"))).toEqual([]);
		expect(
			events
				.filter((event) => event.type === "text")
				.map((event) => event.text)
				.join(""),
		).toBe(enabled ? input : "");
		expect(onError).toHaveBeenCalledWith("Could not complete streaming JSON tool call at finish.", {
			protocol: "hermes",
			retainedLength: input.slice("<tool_call>".length).length,
		});
	});

	it("terminates an already-started malformed complete call as incomplete", () => {
		// given
		const parser = hermesCreateStreamParser([weatherTool]);

		// when
		const events = parser.feed(
			'<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"} malformed}</tool_call>',
		);

		// then
		expect(events).toEqual([
			{ type: "toolcall_start", index: 0, name: "get_weather", id: "hermes-tool-0" },
			{ type: "toolcall_delta", index: 0, argumentsDelta: '{"city":"Seoul"}' },
			{
				type: "toolcall_end",
				index: 0,
				name: "get_weather",
				id: "hermes-tool-0",
				arguments: { city: "Seoul" },
				incomplete: true,
				errorMessage: "Tool call arguments could not be parsed",
			},
		]);
	});

	it("streams recovered qwen-style malformed tool call json as a tool call instead of raw text", () => {
		// given
		const parser = hermesCreateStreamParser([
			{
				name: "read",
				description: "Read a file",
				parameters: Type.Object({
					path: Type.String(),
				}),
			},
		]);

		// when
		const feedEvents = parser.feed(
			'<tool_call>\n"name\': "read", "arguments": {"path": "/tmp/example.txt"}}\n</tool_call>',
		);
		const finishEvents = parser.finish();

		// then
		expect(feedEvents).toEqual([
			{ type: "toolcall_start", index: 0, name: "read", id: "hermes-tool-0" },
			{ type: "toolcall_delta", index: 0, argumentsDelta: '{"path":"/tmp/example.txt"}' },
			{
				type: "toolcall_end",
				index: 0,
				name: "read",
				id: "hermes-tool-0",
				arguments: {
					path: "/tmp/example.txt",
				},
			},
		]);
		expect(finishEvents).toEqual([]);
	});
});
