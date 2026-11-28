import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function makeAgent() {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	return new Agent({
		listenerTimeoutMs: 100,
		streamFn: () => {
			const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
				(event) => event.type === "done" || event.type === "error",
				(event) => {
					if (event.type === "done") return event.message;
					if (event.type === "error") return event.error;
					throw new Error("Expected terminal event");
				},
			);
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("done") });
			});
			return stream;
		},
	});
}

describe("bounded ordered Agent.subscribe listeners (#4054)", () => {
	it("settles a timed-out listener as a local failure and accepts another prompt", async () => {
		const agent = makeAgent();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
		let ends = 0;
		agent.subscribe(async function heldEnd(event) {
			if (event.type !== "agent_end" || ++ends > 1) return;
			entered.resolve();
			await release.promise;
		});
		const first = agent.prompt("first");
		try {
			await entered.promise;
			await vi.advanceTimersByTimeAsync(100);
			expect(agent.state.isStreaming).toBe(false);
			await first;
			expect(agent.state.messages.at(-1)).toMatchObject({ stopReason: "error", failureSource: "local" });
			expect(warnings).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ listener: "heldEnd", event: "agent_end", timeoutMs: 100 }),
			);
			await agent.prompt("second");
			expect(agent.state.isStreaming).toBe(false);
			expect(ends).toBe(2);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			release.resolve();
			await first;
		}
	});

	it("releases a held listener on abort without advancing to its deadline", async () => {
		const agent = makeAgent();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		agent.subscribe(async (event) => {
			if (event.type !== "agent_end") return;
			entered.resolve();
			await release.promise;
		});
		const prompt = agent.prompt("first");
		try {
			await entered.promise;
			agent.abort();
			await vi.advanceTimersByTimeAsync(0);
			expect(agent.state.isStreaming).toBe(false);
			await prompt;
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			release.resolve();
			await prompt;
		}
	});

	it("preserves subscription order for a slow listener inside its budget", async () => {
		const agent = makeAgent();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const order: string[] = [];
		agent.subscribe(async (event) => {
			if (event.type !== "agent_end") return;
			entered.resolve();
			await release.promise;
			order.push("first");
		});
		agent.subscribe((event) => {
			if (event.type === "agent_end") order.push("second");
		});
		const prompt = agent.prompt("first");
		try {
			await entered.promise;
			await vi.advanceTimersByTimeAsync(99);
			expect(order).toEqual([]);
			expect(agent.state.isStreaming).toBe(true);
			release.resolve();
			await prompt;
			expect(order).toEqual(["first", "second"]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			release.resolve();
			await prompt;
		}
	});

	it("observes a late rejection without poisoning the next run", async () => {
		const agent = makeAgent();
		const entered = Promise.withResolvers<void>();
		const late = Promise.withResolvers<void>();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		let held = false;
		agent.subscribe((event) => {
			if (event.type !== "agent_end" || held) return;
			held = true;
			entered.resolve();
			return late.promise;
		});
		const first = agent.prompt("first");
		try {
			await entered.promise;
			await vi.advanceTimersByTimeAsync(100);
			expect(agent.state.isStreaming).toBe(false);
			await first;
			late.reject(new Error("late observer rejection"));
			await agent.prompt("second");
			expect(agent.state.messages.at(-1)).toMatchObject({ stopReason: "stop" });
			expect(agent.state.isStreaming).toBe(false);
		} finally {
			late.resolve();
			await first;
		}
	});
});
