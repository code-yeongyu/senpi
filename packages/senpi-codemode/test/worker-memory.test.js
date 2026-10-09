import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkerMemory } from "../src/kernels/js/worker-memory.js";

const MIB = 1024 * 1024;
const thresholds = { gcWatermarkBytes: 32 * MIB, noticeBytes: 64 * MIB, ceilingBytes: 0 };

function fakeHeap(clock, collectMs) {
	const heap = {
		estimateBytes: 0,
		liveAfterCollect: 0,
		collections: 0,
		canCollect: true,
		idleCollection: true,
		estimate: () => heap.estimateBytes,
		collect() {
			heap.collections += 1;
			clock.now += collectMs;
			heap.estimateBytes = heap.liveAfterCollect;
			return heap.liveAfterCollect;
		},
	};
	return heap;
}

describe("JS worker idle collection rate floor", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("Given a slow collection right before a delete cell when the kernel goes idle then the idle collection is delayed by the floor, never skipped", () => {
		const clock = { now: 0 };
		const heap = fakeHeap(clock, 100);
		const idle = vi.fn();
		const memory = createWorkerMemory(thresholds, idle, { heap, now: () => clock.now });

		heap.estimateBytes = 150 * MIB;
		heap.liveAfterCollect = 150 * MIB;
		const heavy = memory.afterCell();
		memory.cancelIdle();
		heap.liveAfterCollect = 5 * MIB;
		const deleted = memory.afterCell();

		expect(heavy).toMatchObject({ gcRan: true, liveBytes: 150 * MIB });
		expect(deleted.gcRan).toBeUndefined();
		vi.advanceTimersByTime(1_999);
		expect(idle).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(idle).toHaveBeenCalledWith({ liveBytes: 5 * MIB, measure: "heap" });
		expect(heap.collections).toBe(2);
	});

	it("Given a fast collection when the kernel goes idle then the idle collection runs after the one-second delay", () => {
		const clock = { now: 0 };
		const heap = fakeHeap(clock, 1);
		const idle = vi.fn();
		const memory = createWorkerMemory(thresholds, idle, { heap, now: () => clock.now });

		heap.estimateBytes = 150 * MIB;
		heap.liveAfterCollect = 150 * MIB;
		memory.afterCell();

		vi.advanceTimersByTime(999);
		expect(idle).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(idle).toHaveBeenCalledTimes(1);
	});

	it("Given a runtime that collects idle threads itself when a large heap stays live then the worker schedules no idle collection but still measures after the cell", () => {
		const clock = { now: 0 };
		const heap = fakeHeap(clock, 1);
		heap.idleCollection = false;
		const idle = vi.fn();
		const memory = createWorkerMemory(thresholds, idle, { heap, now: () => clock.now });
		heap.estimateBytes = 150 * MIB;

		const report = memory.afterCell();
		vi.advanceTimersByTime(60_000);

		expect(report.gcRan).toBe(true);
		expect(idle).not.toHaveBeenCalled();
	});

	it("Given an idle collection scheduled when the next run arrives then it is cancelled", () => {
		const clock = { now: 0 };
		const heap = fakeHeap(clock, 1);
		const idle = vi.fn();
		const memory = createWorkerMemory(thresholds, idle, { heap, now: () => clock.now });
		heap.estimateBytes = 150 * MIB;
		heap.liveAfterCollect = 150 * MIB;
		memory.afterCell();

		memory.cancelIdle();
		vi.advanceTimersByTime(10_000);

		expect(idle).not.toHaveBeenCalled();
	});
});
