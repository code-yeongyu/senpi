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
});
