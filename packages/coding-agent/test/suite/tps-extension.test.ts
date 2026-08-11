import { afterEach, describe, expect, it, vi } from "vitest";
import tpsExtension from "../../src/core/extensions/builtin/tps.ts";

type ExtensionContextLike = {
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
		const firstMessage = createAssistantMessage({ input: 10, output: 100, cacheRead: 30, cacheWrite: 0 });
		const secondMessage = createAssistantMessage({ input: 20, output: 200, cacheRead: 40, cacheWrite: 0 });

		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		vi.advanceTimersByTime(1_000);

		await harness.emit("message_start", { type: "message_start", message: firstMessage }, ctx);
		vi.advanceTimersByTime(2_000);
		await harness.emit("message_end", { type: "message_end", message: firstMessage }, ctx);
		vi.advanceTimersByTime(5_000);

		await harness.emit("message_start", { type: "message_start", message: secondMessage }, ctx);
		vi.advanceTimersByTime(1_000);
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
		vi.advanceTimersByTime(1_000);
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
		vi.advanceTimersByTime(1_000);
		// Wall clock jumps backward (NTP adjustment / manual change) while
		// monotonic time keeps moving forward.
		vi.setSystemTime(0);
		await harness.emit("message_end", { type: "message_end", message }, ctx);

		await harness.emit("agent_end", { type: "agent_end", messages: [message] }, ctx);

		expect(notifications).toEqual(["TPS 100.0 tok/s. Cache hit 0.0%, 1.0s"]);
	});
});
