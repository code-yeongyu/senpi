import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
	createMorphXmlStreamParser,
	parseMorphXmlGeneratedText,
} from "../../src/tool-call-middleware/protocols/morph-xml.ts";
import type { Tool } from "../../src/types.ts";
import { FIXTURE_TOOLS, TRUNCATION_FIXTURES } from "./truncation-fixtures.ts";

function seededRandom(seed: number): () => number {
	let current = seed;
	return () => {
		current = (current * 9301 + 49_297) % 233_280;
		return current / 233_280;
	};
}

function randomChunkSplit(text: string, minSize = 1, maxSize = 8, seed = 0): string[] {
	const random = seededRandom(seed);
	const chunks: string[] = [];
	let index = 0;
	while (index < text.length) {
		const size = Math.floor(random() * (maxSize - minSize + 1)) + minSize;
		chunks.push(text.slice(index, index + size));
		index += size;
	}
	return chunks;
}

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

	it("reports invalid xml tool calls through onError", () => {
		// given
		const onError = vi.fn();
		const text = "<todowrite><todos><item/></todos></todowrite>";

		// when
		const parsedToolCalls = parseMorphXmlGeneratedText(text, [todoWriteTool], { onError });

		// then
		expect(parsedToolCalls).toEqual([]);
		expect(onError).toHaveBeenCalled();
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

	it("suppresses malformed array<object> xml by default when it cannot satisfy the schema", () => {
		// given
		const parser = createMorphXmlStreamParser([todoWriteTool]);

		// when
		const allEvents = [...parser.feed("<todowrite><todos><item/></todos></todowrite>"), ...parser.finish()];

		// then
		expect(allEvents).toEqual([]);
	});

	it("does not emit partial toolcall progress for arrays that violate minItems before the call is complete", () => {
		// given
		const parser = createMorphXmlStreamParser([todoWriteTool]);

		// when
		const firstEvents = parser.feed("<todowrite><todos></todos>");
		const secondEvents = parser.feed("<content>x</content></todowrite>");

		// then
		expect(firstEvents).toEqual([]);
		expect(secondEvents).toEqual([]);
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

	it("parses self-closing tool calls when whitespace appears after the opening bracket across chunks", () => {
		// given
		const parser = createMorphXmlStreamParser([locationTool]);

		// when
		const allEvents = [...parser.feed("prefix < get_loc"), ...parser.feed("ation/> suffix"), ...parser.finish()];

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
		expect(hasToolCall || textOutput.length === 0).toBe(true);
	});

	it("suppresses malformed xml tool markup by default and reports onError", () => {
		// given
		const onError = vi.fn();
		const parser = createMorphXmlStreamParser([todoWriteTool], { onError });

		// when
		const allEvents = [
			...parser.feed("prefix <todowrite><todos><item/></todos></todowrite> suffix"),
			...parser.finish(),
		];

		// then
		expect(allEvents).toEqual([
			{ type: "text", text: "prefix " },
			{ type: "text", text: " suffix" },
		]);
		expect(onError).toHaveBeenCalled();
	});

	it("emits malformed xml tool markup when raw fallback is explicitly enabled", () => {
		// given
		const parser = createMorphXmlStreamParser([todoWriteTool], { emitRawToolCallTextOnError: true });

		// when
		const allEvents = [
			...parser.feed("prefix <todowrite><todos><item/></todos></todowrite> suffix"),
			...parser.finish(),
		];

		// then
		expect(allEvents).toEqual([
			{ type: "text", text: "prefix " },
			{ type: "text", text: "<todowrite><todos><item/></todos></todowrite>" },
			{ type: "text", text: " suffix" },
		]);
	});

	it("flags unfinished invalid xml tool calls at finish without raw markup", () => {
		// given
		const onError = vi.fn();
		const parser = createMorphXmlStreamParser([todoWriteTool], { onError });

		// when
		const allEvents = [...parser.feed("<todowrite><todos><item/></todos>"), ...parser.finish()];

		// then
		expect(allEvents).toContainEqual(
			expect.objectContaining({
				type: "toolcall_end",
				name: "todowrite",
				incomplete: true,
				errorMessage: "Tool call was truncated mid-arguments",
			}),
		);
		expect(allEvents.filter((event) => event.type === "text")).toEqual([]);
		expect(onError).toHaveBeenCalled();
		expect(JSON.stringify(onError.mock.calls)).not.toContain("<todowrite>");
	});

	it("flags unfinished invalid xml tool calls even when raw fallback is enabled", () => {
		// given
		const parser = createMorphXmlStreamParser([todoWriteTool], { emitRawToolCallTextOnError: true });

		// when
		const allEvents = [...parser.feed("<todowrite><todos><item/></todos>"), ...parser.finish()];

		// then
		expect(allEvents).toContainEqual(
			expect.objectContaining({ type: "toolcall_end", name: "todowrite", incomplete: true }),
		);
		expect(allEvents.filter((event) => event.type === "text")).toEqual([]);
	});

	it.each(TRUNCATION_FIXTURES["morph-xml"])("handles EOF truncation fixture: $title", (fixture) => {
		// given
		const onError = vi.fn();
		const parser = createMorphXmlStreamParser(FIXTURE_TOOLS, { onError });

		// when
		const allEvents = [...parser.feed(fixture.input), ...parser.finish()];
		const toolcallEnds = allEvents.filter((event) => event.type === "toolcall_end");
		const textOutput = allEvents
			.filter((event) => event.type === "text")
			.map((event) => event.text)
			.join("");

		// then
		if (fixture.expected.kind === "recovered") {
			expect(toolcallEnds).toHaveLength(1);
			expect(toolcallEnds[0]).toMatchObject({
				type: "toolcall_end",
				name: fixture.tool,
				arguments: fixture.expected.arguments,
			});
			expect(toolcallEnds[0]).not.toHaveProperty("incomplete");
			return;
		}

		if (fixture.expected.kind === "incomplete") {
			expect(toolcallEnds).toHaveLength(1);
			expect(toolcallEnds[0]).toMatchObject({
				type: "toolcall_end",
				name: fixture.tool,
				incomplete: true,
				errorMessage: "Tool call was truncated mid-arguments",
			});
			expect(textOutput).not.toContain(fixture.input);
			expect(JSON.stringify(onError.mock.calls)).not.toContain(fixture.input);
			return;
		}

		expect(allEvents.filter((event) => event.type.startsWith("toolcall_"))).toEqual([]);
		expect(textOutput).toContain(fixture.input);
	});

	it("flags a stale snapshot instead of executing it", () => {
		// given
		const parser = createMorphXmlStreamParser([weatherTool]);

		// when
		const allEvents = [...parser.feed("<get_weather><city>Seoul</city><days>4"), ...parser.finish()];

		// then
		expect(allEvents).toContainEqual(
			expect.objectContaining({
				type: "toolcall_end",
				name: "get_weather",
				arguments: expect.objectContaining({ city: "Seoul" }),
				incomplete: true,
				errorMessage: "Tool call was truncated mid-arguments",
			}),
		);
		expect(allEvents.filter((event) => event.type === "text")).toEqual([]);
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

	it("handles consecutive tool calls without leaking xml tags into text output", () => {
		// given
		const toolA: Tool = { name: "tool_a", description: "A", parameters: Type.Object({}) };
		const toolB: Tool = { name: "tool_b", description: "B", parameters: Type.Object({}) };
		const parser = createMorphXmlStreamParser([toolA, toolB]);

		// when
		const allEvents = [...parser.feed("<tool_a></tool_a><tool_b></tool_b>"), ...parser.finish()];

		// then
		const toolCalls = allEvents.filter((event) => event.type === "toolcall_end");
		const textOutput = allEvents
			.filter((event) => event.type === "text")
			.map((event) => event.text)
			.join("");
		expect(toolCalls).toHaveLength(2);
		expect(textOutput).not.toContain("<tool_a>");
		expect(textOutput).not.toContain("<tool_b>");
	});

	it("handles tool calls separated only by whitespace without leaking xml tags", () => {
		// given
		const toolA: Tool = { name: "tool_a", description: "A", parameters: Type.Object({}) };
		const toolB: Tool = { name: "tool_b", description: "B", parameters: Type.Object({}) };
		const parser = createMorphXmlStreamParser([toolA, toolB]);

		// when
		const allEvents = [...parser.feed("<tool_a></tool_a>\n  \n<tool_b></tool_b>"), ...parser.finish()];

		// then
		const toolCalls = allEvents.filter((event) => event.type === "toolcall_end");
		const textOutput = allEvents
			.filter((event) => event.type === "text")
			.map((event) => event.text)
			.join("");
		expect(toolCalls).toHaveLength(2);
		expect(textOutput).not.toContain("<tool_a>");
		expect(textOutput).not.toContain("<tool_b>");
	});

	it("handles consecutive tool calls with no text between them", () => {
		// given
		const toolA: Tool = { name: "tool_a", description: "A", parameters: Type.Object({}) };
		const toolB: Tool = { name: "tool_b", description: "B", parameters: Type.Object({}) };
		const parser = createMorphXmlStreamParser([toolA, toolB]);

		// when
		const allEvents = [...parser.feed("<tool_a></tool_a><tool_b></tool_b>"), ...parser.finish()];

		// then
		const toolCalls = allEvents.filter((event) => event.type === "toolcall_end");
		const textOutput = allEvents
			.filter((event) => event.type === "text")
			.map((event) => event.text)
			.join("");
		expect(toolCalls).toHaveLength(2);
		expect(textOutput).not.toContain("<tool_a>");
		expect(textOutput).not.toContain("<tool_b>");
	});

	it("accepts whitespace in the closing tag name while streaming", () => {
		// given
		const locationOnlyTool: Tool = {
			name: "get_weather",
			description: "Get weather",
			parameters: Type.Object({
				city: Type.String(),
			}),
		};
		const parser = createMorphXmlStreamParser([locationOnlyTool]);

		// when
		const allEvents = [...parser.feed("<get_weather><city>SF</city></ get_weather>"), ...parser.finish()];

		// then
		const toolcallEnd = allEvents.find((event) => event.type === "toolcall_end");
		expect(toolcallEnd).toMatchObject({
			type: "toolcall_end",
			name: "get_weather",
			arguments: {
				city: "SF",
			},
		});
	});

	it("parses xml tool calls correctly when streamed character by character", () => {
		// given
		const parser = createMorphXmlStreamParser([weatherTool]);
		const input = "<get_weather><city>Seoul</city><days>3</days></get_weather>";
		const events = [];

		// when
		for (const character of input) {
			events.push(...parser.feed(character));
		}
		events.push(...parser.finish());

		// then
		const toolcallEnd = events.find((event) => event.type === "toolcall_end");
		expect(toolcallEnd).toMatchObject({
			type: "toolcall_end",
			name: "get_weather",
			arguments: {
				city: "Seoul",
				days: 3,
			},
		});
	});

	it.each([0, 1, 7, 13, 21])("keeps tool-call parsing stable across random chunk splits (seed %s)", (seed) => {
		// given
		const parser = createMorphXmlStreamParser([weatherTool]);
		const input = "Checking... <get_weather><city>NYC</city><days>2</days></get_weather> found!";
		const chunks = randomChunkSplit(input, 1, 8, seed);
		const events = [];

		// when
		for (const chunk of chunks) {
			events.push(...parser.feed(chunk));
		}
		events.push(...parser.finish());

		// then
		const toolcallEnd = events.find((event) => event.type === "toolcall_end");
		const textOutput = events
			.filter((event) => event.type === "text")
			.map((event) => event.text)
			.join("");
		expect(toolcallEnd).toMatchObject({
			type: "toolcall_end",
			name: "get_weather",
			arguments: {
				city: "NYC",
				days: 2,
			},
		});
		expect(textOutput).toContain("Checking...");
		expect(textOutput).toContain("found!");
		expect(textOutput).not.toContain("<get_weather>");
	});

	it("suppresses malformed xml tool markup from text output by default when parsing fails", () => {
		// given
		const strictTool: Tool = {
			name: "bad_tool",
			description: "Strict tool",
			parameters: Type.Object({
				name: Type.String(),
			}),
		};
		const parser = createMorphXmlStreamParser([strictTool]);

		// when
		const allEvents = [
			...parser.feed("Calling tool:\n"),
			...parser.feed("<bad_tool><name>first</name><name>second</name></bad_tool>"),
			...parser.feed("\nDone!"),
			...parser.finish(),
		];

		// then
		const toolCalls = allEvents.filter((event) => event.type === "toolcall_end");
		const textOutput = allEvents
			.filter((event) => event.type === "text")
			.map((event) => event.text)
			.join("");
		expect(toolCalls).toHaveLength(0);
		expect(textOutput).toContain("Calling tool:");
		expect(textOutput).toContain("Done!");
		expect(textOutput).not.toContain("<bad_tool>");
		expect(textOutput).not.toContain("</bad_tool>");
		expect(textOutput).not.toContain("<name>");
	});

	it("preserves raw inner xml for string-typed fields", () => {
		// given
		const writeFileTool: Tool = {
			name: "write_file",
			description: "Write a file",
			parameters: Type.Object({
				file_path: Type.String(),
				content: Type.String(),
				encoding: Type.Optional(Type.String()),
			}),
		};
		const parser = createMorphXmlStreamParser([writeFileTool]);
		const html = "<html><body><h1>Hi</h1><p>World</p></body></html>";
		const parts = [
			"<write_file>",
			"<file_path>/home/username/myfile.html</file_path>",
			"<content>",
			html,
			"</content>",
			"<encoding>utf-8</encoding>",
			"</write_file>",
		];
		const events = [];

		// when
		for (const part of parts) {
			for (let index = 0; index < part.length; index += 7) {
				events.push(...parser.feed(part.slice(index, index + 7)));
			}
		}
		events.push(...parser.finish());

		// then
		const toolcallEnd = events.find((event) => event.type === "toolcall_end");
		expect(toolcallEnd).toMatchObject({
			type: "toolcall_end",
			name: "write_file",
			arguments: {
				file_path: "/home/username/myfile.html",
				content: html,
				encoding: "utf-8",
			},
		});
	});
});
