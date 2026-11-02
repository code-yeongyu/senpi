import { afterEach, describe, expect, it, vi } from "vitest";
import { RunBudget, type RunBudgetEvent } from "../src/timeouts/run-budget.ts";

afterEach(() => {
	vi.useRealTimers();
});

function armed(budgetMs: number): { readonly budget: RunBudget; readonly events: RunBudgetEvent[] } {
	const events: RunBudgetEvent[] = [];
	const budget = new RunBudget({ cellId: "cell-1", budgetMs, onExhausted: (event) => events.push(event) });
	return { budget, events };
}

describe("RunBudget", () => {
	it("exhausts exactly when the cell's own running time reaches the budget", async () => {
		vi.useFakeTimers();
		const { events } = armed(2_000);

		await vi.advanceTimersByTimeAsync(1_999);
		expect(events).toEqual([]);

		await vi.advanceTimersByTimeAsync(1);
		expect(events).toHaveLength(1);
		expect(events[0]?.cellId).toBe("cell-1");
		expect(events[0]?.error.name).toBe("TimeoutError");
		expect(events[0]?.error.message).toContain("2s run budget");
	});

	it("does not count time spent parked on a host tool call", async () => {
		vi.useFakeTimers();
		const { budget, events } = armed(2_000);

		await vi.advanceTimersByTimeAsync(1_000);
		budget.pause();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(events).toEqual([]);

		budget.resume();
		await vi.advanceTimersByTimeAsync(999);
		expect(events).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(events).toHaveLength(1);
		expect(budget.consumedMs).toBe(2_000);
	});

	it("resumes counting only when the outermost of nested pauses resumes", async () => {
		vi.useFakeTimers();
		const { budget, events } = armed(2_000);

		budget.pause();
		budget.pause();
		budget.resume();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(events).toEqual([]);

		budget.resume();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(events).toHaveLength(1);
	});

	it("ignores a resume that has no matching pause", async () => {
		vi.useFakeTimers();
		const { budget, events } = armed(2_000);

		budget.resume();
		await vi.advanceTimersByTimeAsync(1_999);
		expect(events).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(events).toHaveLength(1);
	});

	it("never fires after dispose", async () => {
		vi.useFakeTimers();
		const { budget, events } = armed(1_000);

		budget.dispose();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(events).toEqual([]);
	});

	it("fires at most once even when paused and resumed around exhaustion", async () => {
		vi.useFakeTimers();
		const { budget, events } = armed(1_000);

		await vi.advanceTimersByTimeAsync(1_000);
		budget.pause();
		budget.resume();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(events).toHaveLength(1);
	});
});
