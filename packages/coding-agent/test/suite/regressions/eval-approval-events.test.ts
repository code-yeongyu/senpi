import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalHostEvents, ApprovalWaiterError } from "./eval-approval-events.ts";

afterEach(() => vi.useRealTimers());

describe("approval host event waiter cleanup", () => {
	it("delivers the observed event and removes its deadline", async () => {
		// Given an event subscription registered before the host emits its frame.
		vi.useFakeTimers();
		const events = new ApprovalHostEvents();
		const pending = events.waitFor((frame) => frame.type === "approval");
		// When the real wire observer receives the matching frame.
		events.observe('{"type":"approval","command":"echo approved"}', "client");
		// Then the waiter receives that frame without leaving a deadline behind.
		await expect(pending).resolves.toMatchObject({ command: "echo approved" });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejects abandoned subscriptions and clears their deadlines during teardown", async () => {
		// Given a scenario that failed with multiple outstanding host events.
		vi.useFakeTimers();
		const events = new ApprovalHostEvents();
		const pending = [events.waitFor(() => false), events.waitFor(() => false)];
		const outcomes = Promise.allSettled(pending);
		// When its fixture tears down.
		events.dispose();
		// Then both callers receive cancellation and no timer can contaminate a later test.
		for (const outcome of await outcomes) {
			expect(outcome).toMatchObject({ status: "rejected", reason: expect.any(ApprovalWaiterError) });
		}
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps a missing host event observable as a test failure at its watchdog deadline", async () => {
		// Given a subscribed event that the host never emits.
		vi.useFakeTimers();
		const events = new ApprovalHostEvents();
		const pending = events.waitFor(() => false);
		const outcome = pending.then(
			() => undefined,
			(error: unknown) => error,
		);
		// When the event's watchdog expires.
		await vi.advanceTimersByTimeAsync(30_000);
		// Then awaiting the original subscription still reports the missing event.
		expect(await outcome).toBeInstanceOf(ApprovalWaiterError);
		expect(vi.getTimerCount()).toBe(0);
	});
});
