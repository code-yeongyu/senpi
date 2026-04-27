import { afterEach, describe, expect, it, vi } from "vitest";
import {
	complete,
	fauxAssistantMessage,
	fauxOverflowError,
	fauxText,
	registerFauxProvider,
	stream,
} from "../src/index.js";
import type { AssistantMessageEvent, Context } from "../src/types.js";

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

async function collectEvents(streamResult: ReturnType<typeof stream>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of streamResult) {
		events.push(event);
	}
	return events;
}

describe("registerFauxProvider extensions", () => {
	describe("Given a faux provider with three sequential complete() calls using distinct user messages", () => {
		describe("When the call log is read after all calls finish", () => {
			it("Then it returns three ordered RequestSnapshots with context, options, timestamp, and modelId matching each call", async () => {
				const registration = registerFauxProvider();
				registrations.push(registration);
				registration.setResponses([
					fauxAssistantMessage("first reply"),
					fauxAssistantMessage("second reply"),
					fauxAssistantMessage("third reply"),
				]);

				const model = registration.getModel();

				const ctxA: Context = { messages: [{ role: "user", content: "alpha", timestamp: 1 }] };
				const ctxB: Context = { messages: [{ role: "user", content: "beta", timestamp: 2 }] };
				const ctxC: Context = { messages: [{ role: "user", content: "gamma", timestamp: 3 }] };

				await complete(model, ctxA, { sessionId: "sess-A" });
				await complete(model, ctxB, { sessionId: "sess-B" });
				await complete(model, ctxC, { sessionId: "sess-C" });

				const log = registration.getCallLog();

				expect(log).toHaveLength(3);
				expect(registration.state.callCount).toBe(3);

				expect(log[0].timestamp).toBeLessThanOrEqual(log[1].timestamp);
				expect(log[1].timestamp).toBeLessThanOrEqual(log[2].timestamp);

				expect(log[0].modelId).toBe(model.id);
				expect(log[1].modelId).toBe(model.id);
				expect(log[2].modelId).toBe(model.id);

				expect(log[0].context.messages).toEqual(ctxA.messages);
				expect(log[1].context.messages).toEqual(ctxB.messages);
				expect(log[2].context.messages).toEqual(ctxC.messages);

				expect(log[0].options?.sessionId).toBe("sess-A");
				expect(log[1].options?.sessionId).toBe("sess-B");
				expect(log[2].options?.sessionId).toBe("sess-C");
			});
		});
	});

	describe("Given a single call followed by mutation of the original Context array", () => {
		describe("When the call log is read after the mutation", () => {
			it("Then the captured snapshot still reflects the messages observed at call time", async () => {
				const registration = registerFauxProvider();
				registrations.push(registration);
				registration.setResponses([fauxAssistantMessage("ok")]);

				const ctx: Context = { messages: [{ role: "user", content: "first", timestamp: 1 }] };

				await complete(registration.getModel(), ctx);

				ctx.messages.push({ role: "user", content: "added later", timestamp: 2 });

				const log = registration.getCallLog();

				expect(log).toHaveLength(1);
				expect(log[0].context.messages).toHaveLength(1);
				expect(log[0].context.messages[0]).toEqual({ role: "user", content: "first", timestamp: 1 });
			});
		});
	});

	describe("Given a faux provider configured with a schedulerHook that resolves on a fake setTimeout", () => {
		describe("When streaming a multi-chunk text response under vi.useFakeTimers", () => {
			it("Then text deltas are withheld until vi.advanceTimersByTimeAsync ticks the fake clock", async () => {
				vi.useFakeTimers({ toFake: ["setTimeout"] });
				try {
					const registration = registerFauxProvider({
						tokenSize: { min: 1, max: 1 },
						schedulerHook: () => new Promise<void>((resolve) => setTimeout(resolve, 100)),
					});
					registrations.push(registration);

					const fullText = "hello world from faux";
					registration.setResponses([fauxAssistantMessage([fauxText(fullText)])]);

					const events: AssistantMessageEvent[] = [];
					const streamResult = stream(registration.getModel(), {
						messages: [{ role: "user", content: "hi", timestamp: 1 }],
					});

					const consume = (async () => {
						for await (const event of streamResult) {
							events.push(event);
						}
					})();

					await Promise.resolve();
					await Promise.resolve();

					const initialDeltas = events.filter((event) => event.type === "text_delta");
					expect(initialDeltas).toHaveLength(0);

					await vi.advanceTimersByTimeAsync(60_000);
					await consume;

					const allDeltas = events.filter(
						(event): event is Extract<AssistantMessageEvent, { type: "text_delta" }> =>
							event.type === "text_delta",
					);
					expect(allDeltas.length).toBeGreaterThan(0);
					expect(allDeltas.map((event) => event.delta).join("")).toBe(fullText);

					const final = await streamResult.result();
					expect(final.stopReason).toBe("stop");
				} finally {
					vi.useRealTimers();
				}
			});
		});
	});

	describe("Given an overflow error response built via fauxOverflowError('anthropic', overflow phrase)", () => {
		describe("When streaming and collecting all events", () => {
			it("Then exactly one error event is emitted with stopReason 'error', empty content, and an errorMessage matching the overflow regex", async () => {
				const registration = registerFauxProvider();
				registrations.push(registration);

				const phrase = "prompt is too long: 250000 tokens > 200000";
				registration.setResponses([fauxOverflowError("anthropic", phrase)]);

				const events = await collectEvents(
					stream(registration.getModel(), {
						messages: [{ role: "user", content: "hi", timestamp: 1 }],
					}),
				);

				const errorEvents = events.filter(
					(event): event is Extract<AssistantMessageEvent, { type: "error" }> => event.type === "error",
				);
				expect(errorEvents).toHaveLength(1);

				const errorEvent = errorEvents[0];
				expect(errorEvent.reason).toBe("error");
				expect(errorEvent.error.stopReason).toBe("error");
				expect(errorEvent.error.content).toEqual([]);
				expect(errorEvent.error.errorMessage).toMatch(/prompt is too long/i);
				expect(errorEvent.error.errorMessage).toContain("anthropic");
				expect(errorEvent.error.errorMessage).toContain(phrase);
			});
		});
	});

	describe("Given the existing setResponses + appendResponses + state.callCount API used after the extensions land", () => {
		describe("When a sequence of calls drains and refills the queue", () => {
			it("Then state.callCount, getPendingResponseCount, and getCallLog all stay in lockstep with the request count", async () => {
				const registration = registerFauxProvider();
				registrations.push(registration);

				registration.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);

				const ctx: Context = { messages: [{ role: "user", content: "ping", timestamp: 1 }] };

				await complete(registration.getModel(), ctx);
				await complete(registration.getModel(), ctx);

				expect(registration.state.callCount).toBe(2);
				expect(registration.getPendingResponseCount()).toBe(0);
				expect(registration.getCallLog()).toHaveLength(2);

				registration.appendResponses([fauxAssistantMessage("c")]);
				await complete(registration.getModel(), ctx);

				expect(registration.state.callCount).toBe(3);
				expect(registration.getPendingResponseCount()).toBe(0);
				expect(registration.getCallLog()).toHaveLength(3);

				const exhausted = await complete(registration.getModel(), ctx);
				expect(exhausted.stopReason).toBe("error");
				expect(exhausted.errorMessage).toBe("No more faux responses queued");
				expect(registration.state.callCount).toBe(4);
				expect(registration.getCallLog()).toHaveLength(4);
			});
		});
	});
});
