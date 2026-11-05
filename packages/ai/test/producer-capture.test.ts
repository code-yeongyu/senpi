import type Anthropic from "@anthropic-ai/sdk";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as anthropicStream } from "../src/api/anthropic-messages.ts";
import { stream as completionsStream } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessageEvent } from "../src/types.ts";
import {
	assistantRecords,
	getAssistantCapture,
	isAssistantProgress,
	subscribeAssistantCapture,
} from "../src/utils/assistant-capture.ts";
import type { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

import { raw, responses } from "./producer-responses-capture-fixture.ts";

const wire = vi.hoisted(() => ({ chunks: [] as Record<string, unknown>[] }));
vi.mock("openai", () => ({
	default: class {
		chat = {
			completions: {
				create: () => ({
					withResponse: async () => ({
						data: (async function* () {
							yield* wire.chunks;
						})(),
						response: { status: 200, headers: new Headers() },
					}),
				}),
			},
		};
	},
}));
let releaseCapture = () => {};
beforeEach(() => {
	releaseCapture = subscribeAssistantCapture();
});
afterEach(() => {
	vi.restoreAllMocks();
	releaseCapture();
});

const context = normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 1 }] });
async function publicEvents(stream: AssistantMessageEventStream) {
	const events: AssistantMessageEvent[] = [];
	for await (const record of assistantRecords(stream)) if (!isAssistantProgress(record)) events.push(record);
	return events;
}
function anthropic(events: Record<string, unknown>[]) {
	const frames = [
		{ type: "message_start", message: { id: "msg_fixture", usage: { input_tokens: 1, output_tokens: 0 } } },
		...events,
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	const response = new Response(
		frames.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
	const client = {
		beta: { messages: { create: () => ({ asResponse: async () => response }) } },
	} as unknown as Anthropic;
	return anthropicStream(getModel("anthropic", "claude-haiku-4-5"), context, { client });
}
function completions(deferred: boolean, custom = false) {
	wire.chunks = [
		...(deferred
			? [{ choices: [{ delta: { content: "hello", reasoning_content: "thought" }, finish_reason: null }] }]
			: []),
		...[raw.slice(0, 20), "", raw.slice(20)].map((chunk, index) => ({
			choices: [
				{
					delta: {
						tool_calls: [
							{
								index: 0,
								...(index === 0 ? { id: "call_fixture", type: custom ? "custom" : "function" } : {}),
								...(custom
									? { custom: { name: "echo", input: chunk } }
									: { function: { name: "echo", arguments: chunk } }),
							},
						],
					},
					finish_reason: null,
				},
			],
		})),
		{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
	];
	return completionsStream(
		{ ...getModel("openai", "gpt-4o"), api: "openai-completions", compat: { supportsOpenAIGrammarTools: true } },
		normalizeContext({
			messages: [{ role: "user", content: "fixture", timestamp: 1 }],
			tools: [
				{
					name: "echo",
					description: "fixture",
					parameters: Type.Object({ input: Type.String() }),
					...(custom
						? { constrainedSampling: { type: "grammar" as const, variants: { openai_lark: 'start: "ok"' } } }
						: {}),
				},
			],
		}),
		{ apiKey: "fixture", maxRetries: 0 },
	);
}

describe("producer capture #4272", () => {
	it("keeps baseline public bytes for the three provider fixture paths", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1);
		const a = anthropic([
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "call_fixture", name: "echo", input: { initial: true } },
			},
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: raw } },
			{ type: "content_block_stop", index: 0 },
		]);
		await a.result();
		expect(JSON.stringify(await publicEvents(a))).toMatchSnapshot("anthropic public bytes");
		expect(JSON.stringify(await publicEvents(await responses("", true)))).toMatchSnapshot("responses public bytes");
		for (const deferred of [false, true]) {
			const stream = completions(deferred, true);
			await stream.result();
			expect(JSON.stringify(await publicEvents(stream))).toMatchSnapshot(`completions grammar deferred=${deferred}`);
		}
	});
	it("Anthropic freezes an object-only seed before the consumer resumes", async () => {
		const stream = anthropic([
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "call_fixture", name: "echo", input: { initial: true } },
			},
			...[raw.slice(0, 20), "", raw.slice(20)].map((partial_json) => ({
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json },
			})),
			{ type: "content_block_stop", index: 0 },
		]);
		await stream.result();
		const events = await publicEvents(stream);
		const start = toolStart(events);
		expect(getAssistantCapture(start)).toMatchObject({
			block: { arguments: { initial: true } },
			rawArgumentPrefix: "",
			parsedThrough: 0,
			coveredCodeUnits: 0,
		});
		assertDeltas(events, 0);
		expect(Object.isFrozen(getAssistantCapture(start)?.block)).toBe(true);
	});

	it("Responses preserves nonempty raw seed independently of its parsed seed", async () => {
		const events = await publicEvents(await responses(raw.slice(0, 5)));
		expect(getAssistantCapture(toolStart(events))).toMatchObject({
			block: { arguments: {} },
			rawArgumentPrefix: raw.slice(0, 5),
			parsedThrough: 0,
			coveredCodeUnits: 5,
			nextOffset: 5,
		});
		assertDeltas(events, 5);
	});

	it.each([false, true])("Completions records exact coverage with deferred=%s", async (deferred) => {
		const stream = completions(deferred);
		await stream.result();
		const events = await publicEvents(stream);
		expect(getAssistantCapture(toolStart(events))).toMatchObject({
			rawArgumentPrefix: deferred ? raw : "",
			coveredCodeUnits: deferred ? raw.length : 0,
			nextOffset: 0,
			parsedThrough: deferred ? raw.length : 0,
			block: { arguments: deferred ? JSON.parse(raw) : {} },
		});
		assertDeltas(events, 0);
	});

	it("Completions grammar captures the normalized emitted spelling", async () => {
		const stream = completions(true, true);
		await stream.result();
		const events = await publicEvents(stream);
		const deltas = events.filter((event) => event.type === "toolcall_delta");
		const emitted = deltas.map((event) => event.delta).join("");
		expect(JSON.parse(emitted)).toEqual({ input: raw });
		expect(getAssistantCapture(toolStart(events))).toMatchObject({
			rawArgumentPrefix: emitted.slice(0, -2),
			coveredCodeUnits: emitted.length - 2,
		});
	});

	it("Responses queues authoritative raw resets between deltas and ends", async () => {
		const records = [];
		for await (const record of assistantRecords(await responses("", true))) records.push(record);
		expect(records.filter(isAssistantProgress)).toContainEqual({
			type: "message_tool_arguments_reset",
			contentIndex: 0,
			rawArgumentPrefix: '{ "reset": true }',
			parsedThrough: 17,
		});
	});
});

function toolStart(events: AssistantMessageEvent[]): AssistantMessageEvent {
	const start = events.find((event) => event.type === "toolcall_start");
	if (!start) throw new Error("no toolcall_start event");
	return start;
}

function assertDeltas(events: AssistantMessageEvent[], start: number) {
	let offset = start;
	for (const event of events) {
		if (event.type !== "toolcall_delta") continue;
		expect(getAssistantCapture(event)?.offset).toBe(offset);
		offset += event.delta.length;
		expect(Object.keys(event)).not.toContain("capture");
		expect(Object.getOwnPropertySymbols(event)).toHaveLength(0);
	}
	expect(offset).toBe(raw.length);
}
