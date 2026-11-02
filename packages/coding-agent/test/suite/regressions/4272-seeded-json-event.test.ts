import {
	type AssistantMessageEvent,
	carryAssistantCapture,
	subscribeAssistantCapture,
	type ToolCall,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "../../../../ai/src/utils/event-stream.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { toJsonEvent } from "../../../src/modes/json-event.ts";

// Part of #4272 (R3.C6.2 / T6): the opt-in seeded projection reads producer-time capture, never the live partial.

import { assistant, update, usage } from "./4272-seeded-json-fixtures.ts";

const SEEDS = { blockSeeds: 1 } as const;
let release: () => void = () => {};
beforeEach(() => {
	release = subscribeAssistantCapture();
});
afterEach(() => release());

describe("T6 seeded toJsonEvent", () => {
	it("T6 projects every block kind from capture taken when the producer was ahead of the consumer", () => {
		const stream = new AssistantMessageEventStream({ captureBlocks: true });
		const partial = assistant();
		const pushed: AssistantMessageEvent[] = [];
		const push = (event: AssistantMessageEvent, hint?: { rawArgumentPrefix: string; parsedThrough: number }) => {
			pushed.push(event);
			stream.push(event, hint);
		};
		push({ type: "start", partial });
		partial.content.push({ type: "text", text: "Hé" });
		push({ type: "text_start", contentIndex: 0, partial });
		const text = partial.content[0];
		if (text?.type !== "text") throw new Error("fixture text block missing");
		text.text += " 😀";
		push({ type: "text_delta", contentIndex: 0, delta: " 😀", partial });
		text.text += "!";
		push({ type: "text_delta", contentIndex: 0, delta: "!", partial });
		partial.responseId = "resp_1";
		push({ type: "text_end", contentIndex: 0, content: "Hé 😀!", partial });
		partial.content.push({ type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true });
		push({ type: "thinking_start", contentIndex: 1, partial });
		push({ type: "thinking_end", contentIndex: 1, content: "", partial });
		const raw = '{ "path" :\t"a\\u0041';
		const call: ToolCall = { type: "toolCall", id: "call_1", name: "mcp__fs__Read", arguments: { path: "a" } };
		partial.content.push(call);
		push({ type: "toolcall_start", contentIndex: 2, partial }, { rawArgumentPrefix: raw, parsedThrough: 0 });
		push({ type: "toolcall_delta", contentIndex: 2, delta: "", partial });
		push({ type: "toolcall_delta", contentIndex: 2, delta: '" }', partial });
		call.arguments = { path: "aA" };
		push({ type: "toolcall_end", contentIndex: 2, toolCall: call, partial });
		const done: AssistantMessageEvent = { type: "done", reason: "stop", message: partial };
		push(done);
		// Future bytes after every capture: no seed may observe them.
		text.text = "mutated";
		call.arguments = { path: "mutated" };

		const [
			start,
			textStart,
			delta1,
			delta2,
			textEnd,
			thinkingStart,
			thinkingEnd,
			toolStart,
			toolNoGrowth,
			toolDelta,
		] = pushed.map((event) => toJsonEvent(update(event, { resolvedToolName: "read" }), SEEDS));
		const toolEnd = toJsonEvent(update(pushed[10] as AssistantMessageEvent), SEEDS);
		const frozenUsage = { ...usage, cost: { ...usage.cost } };
		expect(start).toMatchObject({
			type: "message_update",
			assistantMessageEvent: { type: "start", seed: { message: { ...assistant(), content: [] } } },
		});
		expect(textStart).toEqual({
			type: "message_update",
			resolvedToolName: "read",
			usage: frozenUsage,
			assistantMessageEvent: {
				type: "text_start",
				contentIndex: 0,
				seed: { block: { type: "text", text: "Hé" }, coveredCodeUnits: 2, nextOffset: 2 },
			},
		});
		expect(
			[delta1, delta2].map((record) => record && "assistantMessageEvent" in record && record.assistantMessageEvent),
		).toEqual([
			{ type: "text_delta", contentIndex: 0, delta: " 😀", offset: 2 },
			{ type: "text_delta", contentIndex: 0, delta: "!", offset: 5 },
		]);
		expect(textEnd).toMatchObject({
			messageMetadata: { responseId: "resp_1" },
			assistantMessageEvent: {
				type: "text_end",
				contentIndex: 0,
				content: "Hé 😀!",
				block: { type: "text", text: "Hé 😀!" },
			},
		});
		expect(thinkingStart).toMatchObject({
			assistantMessageEvent: {
				type: "thinking_start",
				contentIndex: 1,
				seed: {
					block: { type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true },
					coveredCodeUnits: 0,
				},
			},
		});
		expect(thinkingEnd).toMatchObject({ assistantMessageEvent: { type: "thinking_end", content: "" } });
		expect(toolStart).toEqual({
			type: "message_update",
			resolvedToolName: "read",
			usage: frozenUsage,
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 2,
				id: "call_1",
				toolName: "mcp__fs__Read",
				seed: {
					block: { type: "toolCall", id: "call_1", name: "mcp__fs__Read", arguments: { path: "a" } },
					rawArgumentPrefix: raw,
					parsedThrough: 0,
					coveredCodeUnits: raw.length,
					nextOffset: raw.length,
				},
			},
		});
		expect(toolNoGrowth).toMatchObject({
			assistantMessageEvent: { type: "toolcall_delta", delta: "", offset: raw.length, parsedThrough: 0 },
		});
		expect(toolDelta).toMatchObject({
			assistantMessageEvent: {
				type: "toolcall_delta",
				delta: '" }',
				offset: raw.length,
				parsedThrough: raw.length + 3,
			},
		});
		expect(toolEnd).toMatchObject({
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 2,
				toolCall: { type: "toolCall", id: "call_1", name: "mcp__fs__Read", arguments: { path: "aA" } },
			},
		});
		const seed = textStart?.type === "message_update" ? textStart.assistantMessageEvent : undefined;
		expect(seed?.type === "text_start" && Object.isFrozen(seed.seed.block)).toBe(true);
		expect(
			toJsonEvent(update(pushed[2] as AssistantMessageEvent, { messageId: "m-1", turnId: "t-1" }), SEEDS),
		).toMatchObject({
			messageId: "m-1",
			turnId: "t-1",
		});
		for (const record of [start, textStart, delta1, toolStart, toolEnd])
			for (const key of ["messageId", "turnId", "runtimeItemKey"]) expect(record).not.toHaveProperty(key);

		const messageStart = carryAssistantCapture(pushed[0] as AssistantMessageEvent, {
			type: "message_start",
			message: { ...partial },
			clientMessageId: "m1",
		}) as AgentSessionEvent;
		expect(toJsonEvent(messageStart, SEEDS)).toEqual({
			type: "message_start",
			clientMessageId: "m1",
			message: { ...assistant(), content: [] },
		});
		const messageEnd = toJsonEvent(
			carryAssistantCapture(done, { type: "message_end", message: partial }, partial) as AgentSessionEvent,
			SEEDS,
		);
		expect(messageEnd && "message" in messageEnd && Object.isFrozen(messageEnd.message)).toBe(true);
	});

	it("T6 projects a direct error with no start, and leaves non-assistant records untouched", () => {
		const stream = new AssistantMessageEventStream({ captureBlocks: true });
		const failed = { ...assistant(), stopReason: "error" as const, errorMessage: "boom" };
		const error: AssistantMessageEvent = { type: "error", reason: "error", error: failed };
		stream.push(error);
		expect(toJsonEvent(update(error), SEEDS)).toMatchObject({
			assistantMessageEvent: {
				type: "error",
				reason: "error",
				error: { stopReason: "error", errorMessage: "boom" },
			},
		});
		const user: AgentSessionEvent = {
			type: "message_start",
			message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
		};
		expect(toJsonEvent(user, SEEDS)).toBe(user);
		const turn: AgentSessionEvent = { type: "turn_start" };
		expect(toJsonEvent(turn, SEEDS)).toBe(turn);
	});

	it("T6 gives an uncaptured assistant update or start no seeded form (D5: nothing invented)", () => {
		const partial = assistant();
		partial.content.push({ type: "text", text: "late" });
		const uncaptured: AgentSessionEvent = {
			type: "message_update",
			assistantMessageEvent: { type: "text_start", contentIndex: 0, partial },
			message: { ...partial },
		};
		expect(toJsonEvent(uncaptured, SEEDS)).toBeUndefined();
		expect(toJsonEvent({ type: "message_start", message: { ...partial } }, SEEDS)).toBeUndefined();
		const end: AgentSessionEvent = { type: "message_end", message: partial };
		expect(toJsonEvent(end, SEEDS)).toBe(end);
	});

	it("keeps the default projection byte-identical (golden)", () => {
		const stream = new AssistantMessageEventStream({ captureBlocks: true });
		const partial = assistant();
		stream.push({ type: "start", partial });
		partial.content.push({ type: "toolCall", id: "call_1", name: "mcp__fs__Read", arguments: {} });
		const start: AssistantMessageEvent = { type: "toolcall_start", contentIndex: 0, partial };
		stream.push(start);
		const delta: AssistantMessageEvent = { type: "toolcall_delta", contentIndex: 0, delta: "{}", partial };
		stream.push(delta);
		const usageJson =
			'"usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":3,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}';
		expect(JSON.stringify(toJsonEvent(update(start, { resolvedToolName: "read" })))).toBe(
			`{"type":"message_update",${usageJson},"assistantMessageEvent":{"type":"toolcall_start","contentIndex":0,"id":"call_1","toolName":"mcp__fs__Read"},"resolvedToolName":"read"}`,
		);
		expect(JSON.stringify(toJsonEvent(update(delta)))).toBe(
			`{"type":"message_update",${usageJson},"assistantMessageEvent":{"type":"toolcall_delta","contentIndex":0,"delta":"{}"}}`,
		);
		const end: AgentSessionEvent = { type: "message_end", message: partial };
		expect(toJsonEvent(end)).toBe(end);
	});
});
