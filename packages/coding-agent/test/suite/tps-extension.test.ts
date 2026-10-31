import { afterEach, describe, expect, it, vi } from "vitest";
import tpsExtension from "../../src/core/extensions/builtin/tps.ts";

type ExtensionContextLike = {
	mode: "tui";
	hasUI: true;
	ui: {
		notify(message: string): void;
	};
};

type Handler = (event: unknown, ctx: ExtensionContextLike) => unknown | Promise<unknown>;
type TpsExtension = (pi: { on(event: string, handler: Handler): void }) => void;

type UsageFixture = {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
};

function createHarness() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (event: string, handler: Handler) => {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
	};

	(tpsExtension as unknown as TpsExtension)(pi);

	return {
		async emit(event: string, payload: unknown, ctx: ExtensionContextLike) {
			for (const handler of handlers.get(event) ?? []) {
				await handler(payload, ctx);
			}
		},
	};
}

function createContext(notifications: string[]): ExtensionContextLike {
	return {
		mode: "tui",
		hasUI: true,
		ui: {
			notify: (message: string) => {
				notifications.push(message);
			},
		},
	};
}

function createAssistantMessage(usage: UsageFixture): unknown {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		usage: {
			...usage,
			totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function streamDelta(message: unknown): unknown {
	return {
		type: "message_update",
		message,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: message },
	};
}

describe("tps builtin extension", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("reports turn-level cache hit rate in the concise TPS notice", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const notifications: string[] = [];
		const ctx = createContext(notifications);
		const harness = createHarness();
		const firstMessage = createAssistantMessage({
			input: 10,
			output: 100,
			cacheRead: 30,
			cacheWrite: 0,
		});
		const secondMessage = createAssistantMessage({
			input: 20,
			output: 200,
			cacheRead: 40,
			cacheWrite: 0,
		});

		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		vi.advanceTimersByTime(1_000);

		await harness.emit("message_start", { type: "message_start", message: firstMessage }, ctx);
		await harness.emit("message_update", streamDelta(firstMessage), ctx);
		vi.advanceTimersByTime(2_000);
		await harness.emit("message_update", streamDelta(firstMessage), ctx);
		await harness.emit("message_end", { type: "message_end", message: firstMessage }, ctx);
		vi.advanceTimersByTime(5_000);

		await harness.emit("message_start", { type: "message_start", message: secondMessage }, ctx);
		await harness.emit("message_update", streamDelta(secondMessage), ctx);
		vi.advanceTimersByTime(1_000);
		await harness.emit("message_update", streamDelta(secondMessage), ctx);
		await harness.emit("message_end", { type: "message_end", message: secondMessage }, ctx);
		vi.advanceTimersByTime(5_000);

		await harness.emit("agent_end", { type: "agent_end", messages: [firstMessage, secondMessage] }, ctx);

		expect(notifications).toEqual(["TPS 100.0 tok/s. Cache hit 70.0%, 3.0s"]);
		expect(notifications[0]).not.toContain("21.4 tok/s");
	});

	it("reports zero cache hit without raw token counters", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const notifications: string[] = [];
		const ctx = createContext(notifications);
		const harness = createHarness();
		const message = createAssistantMessage({ input: 10, output: 100, cacheRead: 0, cacheWrite: 0 });

		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		await harness.emit("message_start", { type: "message_start", message }, ctx);
		await harness.emit("message_update", streamDelta(message), ctx);
		vi.advanceTimersByTime(1_000);
		await harness.emit("message_update", streamDelta(message), ctx);
		await harness.emit("message_end", { type: "message_end", message }, ctx);
		await harness.emit("agent_end", { type: "agent_end", messages: [message] }, ctx);

		expect(notifications).toEqual(["TPS 100.0 tok/s. Cache hit 0.0%, 1.0s"]);
		expect(notifications[0]).not.toMatch(/\bout |\bin |cache r\/w|total /);
	});

	it("reports TPS when wall clock jumps backward between message_start and message_end", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const notifications: string[] = [];
		const ctx = createContext(notifications);
		const harness = createHarness();
		const message = createAssistantMessage({ input: 10, output: 100, cacheRead: 0, cacheWrite: 0 });

		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		vi.advanceTimersByTime(1_000);

		await harness.emit("message_start", { type: "message_start", message }, ctx);
		await harness.emit("message_update", streamDelta(message), ctx);
		vi.advanceTimersByTime(1_000);
		await harness.emit("message_update", streamDelta(message), ctx);
		// Wall clock jumps backward (NTP adjustment / manual change) while
		// monotonic time keeps moving forward.
		vi.setSystemTime(0);
		await harness.emit("message_end", { type: "message_end", message }, ctx);

		await harness.emit("agent_end", { type: "agent_end", messages: [message] }, ctx);

		expect(notifications).toEqual(["TPS 100.0 tok/s. Cache hit 0.0%, 1.0s"]);
	});
	it("#3393: shows no tok/s for a reply that was not streamed", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const notifications: string[] = [];
		const ctx = createContext(notifications);
		const harness = createHarness();
		const message = createAssistantMessage({ input: 10, output: 100, cacheRead: 0, cacheWrite: 0 });

		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		await harness.emit("message_start", { type: "message_start", message }, ctx);
		vi.advanceTimersByTime(8);
		await harness.emit("message_end", { type: "message_end", message }, ctx);
		await harness.emit("agent_end", { type: "agent_end", messages: [message] }, ctx);

		expect(notifications).toEqual(["Cache hit 0.0%, 0.0s"]);
	});

	it("#3393: shows no tok/s when the streamed generation took under half a second", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const notifications: string[] = [];
		const ctx = createContext(notifications);
		const harness = createHarness();
		const message = createAssistantMessage({ input: 10, output: 100, cacheRead: 0, cacheWrite: 0 });

		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		await harness.emit("message_start", { type: "message_start", message }, ctx);
		vi.advanceTimersByTime(2_000);
		await harness.emit("message_update", streamDelta(message), ctx);
		vi.advanceTimersByTime(300);
		await harness.emit("message_update", streamDelta(message), ctx);
		await harness.emit("message_end", { type: "message_end", message }, ctx);
		await harness.emit("agent_end", { type: "agent_end", messages: [message] }, ctx);

		expect(notifications).toEqual(["Cache hit 0.0%, 2.3s"]);
	});

	it("#3393: measures tok/s from the first streamed token to the last, not from message start", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const notifications: string[] = [];
		const ctx = createContext(notifications);
		const harness = createHarness();
		const message = createAssistantMessage({ input: 10, output: 100, cacheRead: 0, cacheWrite: 0 });

		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		await harness.emit("message_start", { type: "message_start", message }, ctx);
		vi.advanceTimersByTime(3_000);
		await harness.emit("message_update", streamDelta(message), ctx);
		vi.advanceTimersByTime(2_000);
		await harness.emit("message_update", streamDelta(message), ctx);
		await harness.emit("message_end", { type: "message_end", message }, ctx);
		await harness.emit("agent_end", { type: "agent_end", messages: [message] }, ctx);

		expect(notifications).toEqual(["TPS 50.0 tok/s. Cache hit 0.0%, 5.0s"]);
	});
	it("#3393: counts hidden reasoning time when usage.output includes reasoning that never streamed", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const notifications: string[] = [];
		const ctx = createContext(notifications);
		const harness = createHarness();
		const base = createAssistantMessage({ input: 10, output: 3_400, cacheRead: 0, cacheWrite: 0 }) as {
			usage: Record<string, unknown>;
		};
		const message = { ...base, usage: { ...base.usage, reasoning: 3_000 } };

		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		await harness.emit("message_start", { type: "message_start", message }, ctx);
		vi.advanceTimersByTime(30_000);
		await harness.emit("message_update", streamDelta(message), ctx);
		vi.advanceTimersByTime(4_000);
		await harness.emit("message_update", streamDelta(message), ctx);
		await harness.emit("message_end", { type: "message_end", message }, ctx);
		await harness.emit("agent_end", { type: "agent_end", messages: [message] }, ctx);

		expect(notifications).toEqual(["TPS 100.0 tok/s. Cache hit 0.0%, 34.0s"]);
	});

	it("#3393: a reasoning summary streamed after hidden reasoning still counts the reasoning time", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const notifications: string[] = [];
		const ctx = createContext(notifications);
		const harness = createHarness();
		const base = createAssistantMessage({ input: 10, output: 3_400, cacheRead: 0, cacheWrite: 0 }) as {
			usage: Record<string, unknown>;
		};
		const message = { ...base, usage: { ...base.usage, reasoning: 3_000 } };
		const summary = {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "s", partial: message },
		};

		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		await harness.emit("message_start", { type: "message_start", message }, ctx);
		vi.advanceTimersByTime(30_000);
		await harness.emit("message_update", summary, ctx);
		vi.advanceTimersByTime(4_000);
		await harness.emit("message_update", streamDelta(message), ctx);
		await harness.emit("message_end", { type: "message_end", message }, ctx);
		await harness.emit("agent_end", { type: "agent_end", messages: [message] }, ctx);

		expect(notifications).toEqual(["TPS 100.0 tok/s. Cache hit 0.0%, 34.0s"]);
	});

	it("#3393: thinking that streamed nothing and is not in usage.reasoning still counts its time (Bedrock, omitted display)", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const notifications: string[] = [];
		const ctx = createContext(notifications);
		const harness = createHarness();
		const base = createAssistantMessage({ input: 10, output: 3_400, cacheRead: 0, cacheWrite: 0 }) as {
			content: unknown[];
		};
		const message = {
			...base,
			content: [{ type: "thinking", thinking: "", thinkingSignature: "sig" }, ...base.content],
		};

		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		await harness.emit("message_start", { type: "message_start", message }, ctx);
		vi.advanceTimersByTime(30_000);
		await harness.emit("message_update", streamDelta(message), ctx);
		vi.advanceTimersByTime(4_000);
		await harness.emit("message_update", streamDelta(message), ctx);
		await harness.emit("message_end", { type: "message_end", message }, ctx);
		await harness.emit("agent_end", { type: "agent_end", messages: [message] }, ctx);

		expect(notifications).toEqual(["TPS 100.0 tok/s. Cache hit 0.0%, 34.0s"]);
	});

	it("#3393: thinking that streamed live keeps the first-to-last-delta window", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const notifications: string[] = [];
		const ctx = createContext(notifications);
		const harness = createHarness();
		const base = createAssistantMessage({ input: 10, output: 400, cacheRead: 0, cacheWrite: 0 }) as {
			content: unknown[];
		};
		const message = { ...base, content: [{ type: "thinking", thinking: "visible" }, ...base.content] };
		const thinkingDelta = {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "v", partial: message },
		};

		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		await harness.emit("message_start", { type: "message_start", message }, ctx);
		vi.advanceTimersByTime(10_000);
		await harness.emit("message_update", thinkingDelta, ctx);
		vi.advanceTimersByTime(4_000);
		await harness.emit("message_update", streamDelta(message), ctx);
		await harness.emit("message_end", { type: "message_end", message }, ctx);
		await harness.emit("agent_end", { type: "agent_end", messages: [message] }, ctx);

		expect(notifications).toEqual(["TPS 100.0 tok/s. Cache hit 0.0%, 14.0s"]);
	});

	it("#3393: an aborted message adds neither its time nor its tokens to the rate", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const notifications: string[] = [];
		const ctx = createContext(notifications);
		const harness = createHarness();
		const aborted = {
			...(createAssistantMessage({ input: 10, output: 40, cacheRead: 0, cacheWrite: 0 }) as object),
			stopReason: "aborted",
		};
		const message = createAssistantMessage({ input: 10, output: 100, cacheRead: 0, cacheWrite: 0 });

		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		await harness.emit("message_start", { type: "message_start", message: aborted }, ctx);
		await harness.emit("message_update", streamDelta(aborted), ctx);
		vi.advanceTimersByTime(5_000);
		await harness.emit("message_update", streamDelta(aborted), ctx);
		await harness.emit("message_end", { type: "message_end", message: aborted }, ctx);
		await harness.emit("message_start", { type: "message_start", message }, ctx);
		await harness.emit("message_update", streamDelta(message), ctx);
		vi.advanceTimersByTime(1_000);
		await harness.emit("message_update", streamDelta(message), ctx);
		await harness.emit("message_end", { type: "message_end", message }, ctx);
		await harness.emit("agent_end", { type: "agent_end", messages: [aborted, message] }, ctx);

		expect(notifications).toEqual(["TPS 100.0 tok/s. Cache hit 0.0%, 6.0s"]);
	});
});
