import {
	type AssistantMessage,
	type AssistantMessageEvent,
	carryAssistantCapture,
	subscribeAssistantCapture,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "../../../../ai/src/utils/event-stream.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { toJsonEvent } from "../../../src/modes/json-event.ts";

const usage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(): AssistantMessage {
	return {
		role: "assistant",
		api: "faux",
		provider: "faux",
		model: "fixture",
		content: [],
		timestamp: 1,
		stopReason: "stop",
		usage: { ...usage, cost: { ...usage.cost } },
	};
}

const SEEDS = { blockSeeds: 1 } as const;
let release: () => void = () => {};
beforeEach(() => {
	release = subscribeAssistantCapture();
});
afterEach(() => release());

describe("T6 changed-byte work", () => {
	it("T6 never reads, clones, parses or stringifies content on an ordinary delta (D3: 0 parses over no-growth deltas)", () => {
		const stream = new AssistantMessageEventStream({ captureBlocks: true });
		const partial = assistant();
		stream.push({ type: "start", partial });
		partial.content.push({ type: "text", text: "" });
		stream.push({ type: "text_start", contentIndex: 0, partial });
		const chunk = "x".repeat(1024);
		const deltas: AssistantMessageEvent[] = [];
		for (let index = 0; index < 1024; index++) {
			const block = partial.content[0];
			if (block?.type === "text") block.text += chunk;
			const event: AssistantMessageEvent = { type: "text_delta", contentIndex: 0, delta: chunk, partial };
			stream.push(event);
			deltas.push(event);
		}
		partial.content.push({ type: "toolCall", id: "call_1", name: "read", arguments: { path: "seed" } });
		stream.push({ type: "toolcall_start", contentIndex: 1, partial }, { rawArgumentPrefix: "", parsedThrough: 0 });
		const noGrowth: AssistantMessageEvent[] = [];
		for (let index = 0; index < 64; index++) {
			const event: AssistantMessageEvent = { type: "toolcall_delta", contentIndex: 1, delta: "", partial };
			stream.push(event);
			noGrowth.push(event);
		}
		const reads: string[] = [];
		const allowed = new Set(["type", "contentIndex", "delta"]);
		const watched = <T extends object>(label: string, target: T, keys: Set<string>): T =>
			new Proxy(target, {
				get(source, key, receiver) {
					if (!keys.has(String(key))) reads.push(`${label}.${String(key)}`);
					return Reflect.get(source, key, receiver);
				},
			});
		const records = [...deltas, ...noGrowth].map((event) =>
			carryAssistantCapture(event, {
				type: "message_update",
				assistantMessageEvent: watched("event", event, allowed),
				message: watched("message", { ...partial }, new Set()),
			}),
		) as AgentSessionEvent[];
		const parse = vi.spyOn(JSON, "parse");
		const stringify = vi.spyOn(JSON, "stringify");
		const clone = vi.spyOn(globalThis, "structuredClone");
		let projected: ReturnType<typeof toJsonEvent>[] = [];
		try {
			projected = records.map((record) => toJsonEvent(record, SEEDS));
			expect(reads, "an ordinary delta must not touch the message, partial or block").toEqual([]);
			expect(parse).not.toHaveBeenCalled();
			expect(stringify).not.toHaveBeenCalled();
			expect(clone).not.toHaveBeenCalled();
		} finally {
			parse.mockRestore();
			stringify.mockRestore();
			clone.mockRestore();
		}
		const sizes = projected.slice(0, 1024).map((record) => Buffer.byteLength(JSON.stringify(record)));
		console.log(
			`T6 seeded text_delta bytes: first ${sizes[0]}, last ${sizes.at(-1)}, total ${sizes.reduce((a, b) => a + b, 0)}`,
		);
		// Only the offset's digits grow (1 to 7); the record never carries the 1 MiB prefix.
		expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(6);
		expect(
			projected
				.slice(1024)
				.map((record) => record && "assistantMessageEvent" in record && record.assistantMessageEvent),
		).toEqual(
			noGrowth.map(() => ({ type: "toolcall_delta", contentIndex: 1, delta: "", offset: 0, parsedThrough: 0 })),
		);
	});
});
