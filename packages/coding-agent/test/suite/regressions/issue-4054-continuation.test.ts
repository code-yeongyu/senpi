import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunContinuations } from "../../../src/core/agent-run-continuation.ts";

afterEach(() => vi.useRealTimers());

describe("bounded core settlement wait (#4054)", () => {
	it.each(["timeout", "abort"] as const)("releases the settlement waiter on %s", async (reason) => {
		vi.useFakeTimers();
		const tracker = new AgentRunContinuations();
		const end: AgentEvent = { type: "agent_end", messages: [] };
		tracker.observe(end);
		const idle = Promise.withResolvers<void>();
		const controller = new AbortController();
		let outcome: unknown;
		const waiting = tracker
			.idleOrContinued(end, () => idle.promise, {
				signal: controller.signal,
				timeoutMs: 100,
			})
			.then(
				(value) => {
					outcome = value;
				},
				(error: unknown) => {
					outcome = error;
				},
			);
		try {
			if (reason === "abort") controller.abort();
			await vi.advanceTimersByTimeAsync(reason === "timeout" ? 100 : 0);
			expect(outcome).toMatchObject({ reason });
			await waiting;
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			idle.resolve();
			await waiting;
		}
	});

	it("lets a later agent_start win and removes the losing deadline", async () => {
		vi.useFakeTimers();
		const tracker = new AgentRunContinuations();
		const end: AgentEvent = { type: "agent_end", messages: [] };
		tracker.observe(end);
		const idle = Promise.withResolvers<void>();
		const waiting = tracker.idleOrContinued(end, () => idle.promise, { timeoutMs: 100 });
		tracker.observe({ type: "agent_start" });
		expect(await waiting).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		idle.resolve();
	});

	it.each(["timeout", "abort"] as const)("keeps a new loop when %s races its start", async (reason) => {
		vi.useFakeTimers();
		const tracker = new AgentRunContinuations();
		const end: AgentEvent = { type: "agent_end", messages: [] };
		tracker.observe(end);
		const idle = Promise.withResolvers<void>();
		const controller = new AbortController();
		const waiting = tracker
			.idleOrContinued(end, () => idle.promise, { signal: controller.signal, timeoutMs: 100 })
			.then(
				(value) => value,
				(error: unknown) => error,
			);
		if (reason === "abort") controller.abort();
		else vi.advanceTimersByTime(100);
		tracker.observe({ type: "agent_start" });
		try {
			expect(await waiting).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			idle.resolve();
		}
	});
});
