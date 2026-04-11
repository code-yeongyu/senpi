import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
	createMorphXmlStreamParser,
	parseMorphXmlGeneratedText,
} from "../../src/tool-call-middleware/protocols/morph-xml.js";
import type { Tool } from "../../src/types.js";

describe("parseMorphXmlGeneratedText", () => {
	const weatherTool: Tool = {
		name: "get_weather",
		description: "Get weather for a location",
		parameters: Type.Object({
			city: Type.String(),
			days: Type.Integer(),
		}),
	};

	const todoWriteTool: Tool = {
		name: "todowrite",
		description: "Write todos",
		parameters: Type.Object({
			todos: Type.Array(
				Type.Object({
					content: Type.String(),
					status: Type.String(),
					priority: Type.String(),
				}),
			),
		}),
	};

	const locationTool: Tool = {
		name: "get_location",
		description: "Get the location",
		parameters: Type.Object({}),
	};

	it("parses multiple XML tool calls with string and number parameters", () => {
		// given
		const text = [
			"Here you go",
			"<get_weather><city>Seoul</city><days>3</days></get_weather>",
			"<get_weather><city>Busan</city><days>1</days></get_weather>",
		].join("\n");

		// when
		const parsedToolCalls = parseMorphXmlGeneratedText(text, [weatherTool]);

		// then
		expect(parsedToolCalls).toEqual([
			{
				name: "get_weather",
				arguments: {
					city: "Seoul",
					days: 3,
				},
			},
			{
				name: "get_weather",
				arguments: {
					city: "Busan",
					days: 1,
				},
			},
		]);
	});

	it("coerces string values using the tool schema", () => {
		// given
		const text = "<get_weather><city>Tokyo</city><days>42</days></get_weather>";

		// when
		const [parsedToolCall] = parseMorphXmlGeneratedText(text, [weatherTool]);

		// then
		expect(parsedToolCall).toEqual({
			name: "get_weather",
			arguments: {
				city: "Tokyo",
				days: 42,
			},
		});
		expect(typeof parsedToolCall?.arguments.days).toBe("number");
	});

	it("rejects malformed array<object> payloads instead of coercing empty items into strings", () => {
		// given
		const text = "<todowrite><todos><item/></todos></todowrite>";

		// when
		const parsedToolCalls = parseMorphXmlGeneratedText(text, [todoWriteTool]);

		// then
		expect(parsedToolCalls).toEqual([]);
	});

	it("rejects array<object> payloads when object fields are provided without item wrappers", () => {
		// given
		const text =
			"<todowrite><todos><content>Inspect code</content><status>pending</status><priority>high</priority></todos></todowrite>";

		// when
		const parsedToolCalls = parseMorphXmlGeneratedText(text, [todoWriteTool]);

		// then
		expect(parsedToolCalls).toEqual([]);
	});

	it("parses self-closing tool calls without arguments", () => {
		// given
		const text = "<get_location/>";

		// when
		const parsedToolCalls = parseMorphXmlGeneratedText(text, [locationTool]);

		// then
		expect(parsedToolCalls).toEqual([
			{
				name: "get_location",
				arguments: {},
			},
		]);
	});

	it("parses self-closing tool calls with surrounding text", () => {
		// given
		const text = "prefix <get_location /> suffix";

		// when
		const parsedToolCalls = parseMorphXmlGeneratedText(text, [locationTool]);

		// then
		expect(parsedToolCalls).toEqual([
			{
				name: "get_location",
				arguments: {},
			},
		]);
	});
});

describe("createMorphXmlStreamParser", () => {
	const weatherTool: Tool = {
		name: "get_weather",
		description: "Get weather for a location",
		parameters: Type.Object({
			city: Type.String(),
			days: Type.Integer(),
		}),
	};

	const todoWriteTool: Tool = {
		name: "todowrite",
		description: "Write todos",
		parameters: Type.Object({
			todos: Type.Array(
				Type.Object({
					content: Type.String(),
					status: Type.String(),
					priority: Type.String(),
				}),
			),
		}),
	};

	const locationTool: Tool = {
		name: "get_location",
		description: "Get the location",
		parameters: Type.Object({}),
	};

	it("emits streaming events while parsing incremental XML tool call content", () => {
		// given
		const parser = createMorphXmlStreamParser([weatherTool]);

		// when
		const firstEvents = parser.feed("Before <get_weather><city>Seo");
		const secondEvents = parser.feed("ul</city><days>4</days></get_weather> After");
		const finalEvents = parser.finish();
		const allEvents = [...firstEvents, ...secondEvents, ...finalEvents];

		// then
		expect(allEvents).toContainEqual({ type: "text", text: "Before " });
		expect(allEvents).toContainEqual(
			expect.objectContaining({ type: "toolcall_start", index: 0, name: "get_weather" }),
		);
		expect(allEvents).toContainEqual(
			expect.objectContaining({ type: "toolcall_delta", index: 0, argumentsDelta: '{"city":"Seo"}' }),
		);
		expect(allEvents).toContainEqual(
			expect.objectContaining({ type: "toolcall_delta", index: 0, argumentsDelta: '{"city":"Seoul","days":4}' }),
		);
		expect(allEvents).toContainEqual({ type: "text", text: " After" });
		expect(allEvents).toContainEqual(
			expect.objectContaining({
				type: "toolcall_end",
				index: 0,
				name: "get_weather",
				arguments: {
					city: "Seoul",
					days: 4,
				},
			}),
		);
	});

	it("falls back to text when a self-closing array<object> item cannot satisfy the schema", () => {
		// given
		const parser = createMorphXmlStreamParser([todoWriteTool]);

		// when
		const allEvents = [...parser.feed("<todowrite><todos><item/></todos></todowrite>"), ...parser.finish()];

		// then
		expect(allEvents).toEqual([{ type: "text", text: "<todowrite><todos><item/></todos></todowrite>" }]);
	});

	it("does not emit partial toolcall progress for arrays that violate minItems before the call is complete", () => {
		// given
		const parser = createMorphXmlStreamParser([todoWriteTool]);

		// when
		const firstEvents = parser.feed("<todowrite><todos></todos>");
		const secondEvents = parser.feed("<content>x</content></todowrite>");

		// then
		expect(firstEvents).toEqual([]);
		expect(secondEvents).toEqual([
			{ type: "text", text: "<todowrite><todos></todos><content>x</content></todowrite>" },
		]);
	});

	it("parses self-closing tool calls in the stream", () => {
		// given
		const parser = createMorphXmlStreamParser([locationTool]);

		// when
		const allEvents = [...parser.feed("<get_location/>"), ...parser.finish()];

		// then
		expect(allEvents).toEqual([
			{ type: "toolcall_start", index: 0, name: "get_location", id: expect.any(String) },
			{ type: "toolcall_end", index: 0, name: "get_location", id: expect.any(String), arguments: {} },
		]);
	});

	it("parses self-closing tool calls with surrounding text in the stream", () => {
		// given
		const parser = createMorphXmlStreamParser([locationTool]);

		// when
		const allEvents = [...parser.feed("prefix <get_location /> suffix"), ...parser.finish()];

		// then
		expect(allEvents).toEqual([
			{ type: "text", text: "prefix " },
			{ type: "toolcall_start", index: 0, name: "get_location", id: expect.any(String) },
			{ type: "toolcall_end", index: 0, name: "get_location", id: expect.any(String), arguments: {} },
			{ type: "text", text: " suffix" },
		]);
	});

	it("handles mismatched inner XML without throwing", () => {
		// given
		const parser = createMorphXmlStreamParser([weatherTool]);

		// when
		const allEvents = [...parser.feed("<get_weather><location>NY</get_weather>"), ...parser.finish()];

		// then
		const hasToolCall = allEvents.some((event) => event.type === "toolcall_end");
		const textOutput = allEvents
			.filter((event) => event.type === "text")
			.map((event) => event.text)
			.join("");
		expect(hasToolCall || textOutput.length > 0).toBe(true);
	});

	it("force-completes unfinished calls at finish when the partial xml is parseable", () => {
		// given
		const parser = createMorphXmlStreamParser([weatherTool]);

		// when
		const allEvents = [...parser.feed("<get_weather><location>NY"), ...parser.finish()];

		// then
		const toolcallEnd = allEvents.find((event) => event.type === "toolcall_end");
		if (toolcallEnd?.type === "toolcall_end") {
			expect(toolcallEnd.arguments).toEqual({ location: "NY" });
		} else {
			const textOutput = allEvents
				.filter((event) => event.type === "text")
				.map((event) => event.text)
				.join("");
			expect(textOutput).not.toContain("<get_weather>");
		}
	});
});
