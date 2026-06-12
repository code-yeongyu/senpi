import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/types.ts";
import { AssistantMessageEventStream, EventStream } from "../src/utils/event-stream.ts";

function createPartial(text = ""): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("AssistantMessageEventStream", () => {
	it("queues adjacent delta events immediately without throttling or merging", () => {
		const stream = new AssistantMessageEventStream();

		stream.push({ type: "text_delta", contentIndex: 0, delta: "a", partial: createPartial("a") });
		stream.push({ type: "text_delta", contentIndex: 0, delta: "b", partial: createPartial("ab") });

		expect(stream.queue).toHaveLength(2);
		expect(stream.queue[0]).toMatchObject({ type: "text_delta", delta: "a" });
		expect(stream.queue[1]).toMatchObject({ type: "text_delta", delta: "b" });
	});
});

describe("EventStream deque semantics", () => {
	const makeStream = () =>
		new EventStream<{ readonly n: number; readonly final?: boolean }, number>(
			(event) => event.final === true,
			(event) => event.n,
		);

	it("preserves FIFO across the compaction boundary when more events are pushed later", async () => {
		const stream = makeStream();
		const total = 3000;
		for (let i = 0; i < 1500; i++) stream.push({ n: i });

		const seen: number[] = [];
		const iterator = stream[Symbol.asyncIterator]();
		for (let i = 0; i < 1300; i++) {
			const result = await iterator.next();
			expect(result.done).toBe(false);
			if (!result.done) seen.push(result.value.n);
		}

		for (let i = 1500; i < total; i++) stream.push({ n: i });
		stream.push({ n: total, final: true });

		let result = await iterator.next();
		while (!result.done) {
			seen.push(result.value.n);
			result = await iterator.next();
		}

		expect(seen).toHaveLength(total + 1);
		for (let i = 0; i < seen.length; i++) expect(seen[i]).toBe(i);
		await expect(stream.result()).resolves.toBe(total);
	});

	it("returns a defensive queue snapshot that cannot desync internal state", async () => {
		const stream = makeStream();
		for (let i = 0; i < 5; i++) stream.push({ n: i });

		const snapshot = stream.queue;
		expect(snapshot).toHaveLength(5);
		snapshot.length = 0;

		const iterator = stream[Symbol.asyncIterator]();
		for (let i = 0; i < 5; i++) {
			const result = await iterator.next();
			expect(result.done).toBe(false);
			if (!result.done) expect(result.value.n).toBe(i);
		}
		expect(stream.queue).toHaveLength(0);
	});

	it("rejects waiters and result after draining queued events when it fails", async () => {
		const stream = makeStream();
		stream.push({ n: 0 });
		stream.push({ n: 1 });
		const error = new Error("boom");
		stream.fail(error);

		const seen: number[] = [];
		let thrown: unknown;
		try {
			for await (const event of stream) seen.push(event.n);
		} catch (caught) {
			thrown = caught;
		}

		expect(seen).toEqual([0, 1]);
		expect(thrown).toBe(error);
		await expect(stream.result()).rejects.toBe(error);
	});

	it("delivers directly to a waiting consumer without touching the queue", async () => {
		const stream = makeStream();
		const iterator = stream[Symbol.asyncIterator]();
		const pending = iterator.next();
		stream.push({ n: 42 });

		const result = await pending;
		expect(result.done).toBe(false);
		if (!result.done) expect(result.value.n).toBe(42);
		expect(stream.queue).toHaveLength(0);
	});
});
