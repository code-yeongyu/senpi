import type { AgentToolResult } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvalDetachedCellManager, type EvalDetachedCellNotification } from "../src/tool/detached-cell-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { EvalToolDetails } from "../src/tool/types.ts";
import { FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";

afterEach(() => {
	vi.useRealTimers();
});

class NotificationRecorder {
	readonly batches: EvalDetachedCellNotification[][] = [];

	notify(cells: readonly EvalDetachedCellNotification[]): void {
		this.batches.push([...cells]);
	}

	get notices(): EvalDetachedCellNotification[] {
		return this.batches.flat();
	}
}

function liveResultFor(output: string): () => AgentToolResult<EvalToolDetails> {
	return () => ({
		content: [{ type: "text", text: output }],
		details: {
			language: "js",
			languages: ["js"],
			durationMs: 0,
			toolCalls: [],
			truncated: false,
			cells: [{ index: 0, code: "await forever", language: "js", output, status: "running", durationMs: 0 }],
		},
	});
}

function input(overrides: { timeout?: number } = {}) {
	return {
		language: "js" as const,
		code: "await forever",
		summary: "long running cell",
		...(overrides.timeout === undefined ? {} : { timeout: overrides.timeout }),
	};
}

function interactiveContext() {
	return { ...fakeExtensionContext(), mode: "tui" as const };
}

function createTool(manager: EvalDetachedCellManager, kernel: FakeKernel) {
	return createEvalTool({
		enabledLanguages: { js: true, py: false, rb: false, jl: false },
		kernelManager: new FakeManager([["js", kernel]]),
		cellTimeoutSeconds: 1,
		executeTool: vi.fn(),
		cellManager: manager,
	});
}

async function settled(execution: Promise<unknown>): Promise<{ status: string; reason?: Error }> {
	return await execution.then(
		() => ({ status: "fulfilled" }),
		(reason: Error) => ({ status: "rejected", reason }),
	);
}

describe("eval run budget on detached cells", () => {
	it("kills a detached cell once its own running time reaches the run budget", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager({ runBudgetSeconds: 2, hardLimitSeconds: 100 });
		const kernel = new FakeKernel([]);
		const cell = manager.create("runaway-cell", input());
		manager.markRunning(cell, kernel, liveResultFor("still computing"));
		manager.detach(cell);

		await vi.advanceTimersByTimeAsync(1_999);
		expect(kernel.interrupts).toEqual([]);
		expect(manager.peek("runaway-cell").state).toBe("detached");

		await vi.advanceTimersByTimeAsync(1);

		expect(kernel.interrupts).toHaveLength(1);
		expect(kernel.interrupts[0]).toContain("run budget");
		expect(manager.peek("runaway-cell")).toMatchObject({ state: "cancelled", runBudgetSeconds: 2 });
		expect(manager.peek("runaway-cell").hardLimitSeconds).toBeUndefined();
		expect(manager.busyFor("js")).toBeUndefined();
	});

	it("tells the main agent the detached cell exhausted its run budget", async () => {
		vi.useFakeTimers();
		const recorder = new NotificationRecorder();
		const manager = new EvalDetachedCellManager({ runBudgetSeconds: 2, hardLimitSeconds: 100, notifier: recorder });
		const kernel = new FakeKernel([]);
		const cell = manager.create("notified-cell", input());
		manager.markRunning(cell, kernel, liveResultFor("buffered print"));
		manager.detach(cell);

		await vi.advanceTimersByTimeAsync(2_000);
		await manager.flushNotifications();

		expect(recorder.notices).toHaveLength(1);
		expect(recorder.notices[0]?.content).toContain("2s run budget");
		expect(recorder.notices[0]?.content).toContain("buffered print");
	});

	it("does not charge time parked on a host tool call and resumes counting afterwards", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager({ runBudgetSeconds: 2, hardLimitSeconds: 100 });
		const kernel = new FakeKernel([]);
		const cell = manager.create("parked-cell", input());
		manager.markRunning(cell, kernel, liveResultFor("waiting on agent()"));
		manager.detach(cell);

		await vi.advanceTimersByTimeAsync(1_000);
		manager.pause(cell);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(manager.peek("parked-cell").state).toBe("detached");

		manager.resume(cell);
		await vi.advanceTimersByTimeAsync(999);
		expect(manager.peek("parked-cell").state).toBe("detached");
		await vi.advanceTimersByTimeAsync(1);
		expect(manager.peek("parked-cell")).toMatchObject({ state: "cancelled", runBudgetSeconds: 2 });
	});

	it("still kills a parked cell at the wall-clock hard limit", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager({ runBudgetSeconds: 50, hardLimitSeconds: 2 });
		const kernel = new FakeKernel([]);
		const cell = manager.create("parked-forever", input());
		manager.markRunning(cell, kernel, liveResultFor("waiting"));
		manager.detach(cell);
		manager.pause(cell);

		await vi.advanceTimersByTimeAsync(2_000);

		expect(manager.peek("parked-forever")).toMatchObject({ state: "cancelled", hardLimitSeconds: 2 });
		expect(manager.peek("parked-forever").runBudgetSeconds).toBeUndefined();
	});

	it("never interrupts a cell that settles within its budget", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager({ runBudgetSeconds: 2, hardLimitSeconds: 100 });
		const kernel = new FakeKernel([]);
		const cell = manager.create("fast-cell", input());
		manager.markRunning(cell, kernel, liveResultFor("done"));
		manager.detach(cell);
		manager.complete(cell, liveResultFor("done")());

		await vi.advanceTimersByTimeAsync(10_000);

		expect(kernel.interrupts).toEqual([]);
		expect(manager.peek("fast-cell").state).toBe("completed");
		expect(manager.peek("fast-cell").runBudgetSeconds).toBeUndefined();
	});

	it("uses an explicit timeout as the run budget in both directions", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager({ runBudgetSeconds: 10, hardLimitSeconds: 100 });
		const shortKernel = new FakeKernel([]);
		const short = manager.create("short-budget", input({ timeout: 1 }));
		manager.markRunning(short, shortKernel, liveResultFor("short"));
		manager.detach(short);
		const longKernel = new FakeKernel([]);
		const long = manager.create("long-budget", { ...input({ timeout: 20 }), language: "js" });
		manager.markRunning(long, longKernel, liveResultFor("long"));

		await vi.advanceTimersByTimeAsync(1_000);
		expect(manager.peek("short-budget")).toMatchObject({ state: "cancelled", runBudgetSeconds: 1 });

		await vi.advanceTimersByTimeAsync(18_999);
		expect(longKernel.interrupts).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(longKernel.interrupts).toHaveLength(1);
		expect(manager.peek("long-budget")).toMatchObject({ state: "cancelled", runBudgetSeconds: 20 });
	});
});

describe("eval run budget through the tool path", () => {
	it("detaches at the idle budget regardless of a larger timeout, then the run budget kills the detached cell", async () => {
		vi.useFakeTimers();
		const recorder = new NotificationRecorder();
		const manager = new EvalDetachedCellManager({ runBudgetSeconds: 50, hardLimitSeconds: 100, notifier: recorder });
		const kernel = new FakeKernel([]);
		const tool = createTool(manager, kernel);
		const started = kernel.deferNextRun();
		const execution = tool.execute(
			"declared-long",
			{ ...input({ timeout: 3 }), on_timeout: "detach" },
			undefined,
			undefined,
			interactiveContext(),
		);
		await started;

		await vi.advanceTimersByTimeAsync(1_000);
		await execution;
		expect(manager.peek("declared-long").state).toBe("detached");

		await vi.advanceTimersByTimeAsync(1_999);
		expect(manager.peek("declared-long").state).toBe("detached");
		await vi.advanceTimersByTimeAsync(1);
		await manager.flushNotifications();

		expect(manager.peek("declared-long")).toMatchObject({ state: "cancelled", runBudgetSeconds: 3 });
		expect(recorder.notices[0]?.content).toContain("3s run budget");
	});

	it("bounds a print-mode cell by the run budget instead of the idle timeout", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager({ runBudgetSeconds: 3, hardLimitSeconds: 100 });
		const kernel = new FakeKernel([]);
		kernel.stateRetainedOnInterrupt = true;
		const tool = createTool(manager, kernel);
		const started = kernel.deferNextRun();
		const outcome = settled(tool.execute("print-cell", input(), undefined, undefined, fakeExtensionContext()));
		await started;

		await vi.advanceTimersByTimeAsync(2_999);
		expect(kernel.interrupts).toEqual([]);

		await vi.advanceTimersByTimeAsync(1);
		const result = await outcome;
		expect(result.status).toBe("rejected");
		expect(result.reason?.name).toBe("TimeoutError");
		expect(result.reason?.message).toContain("3s run budget");
		expect(result.reason?.message).toMatch(/remains running|preserved/i);
		expect(manager.peek("print-cell")).toMatchObject({ state: "cancelled", runBudgetSeconds: 3 });
	});

	it("freezes the run budget while the kernel reports a bridge call in flight", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager({ runBudgetSeconds: 2, hardLimitSeconds: 100 });
		const kernel = new FakeKernel([{ type: "status", event: { op: "timeout-pause" } }]);
		const tool = createTool(manager, kernel);
		const started = kernel.deferNextRun();
		const outcome = settled(tool.execute("bridge-cell", input(), undefined, undefined, fakeExtensionContext()));
		await started;

		await vi.advanceTimersByTimeAsync(30_000);
		expect(kernel.interrupts).toEqual([]);

		kernel.emit({ type: "status", event: { op: "timeout-resume" } });
		await vi.advanceTimersByTimeAsync(1_999);
		expect(kernel.interrupts).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);

		const result = await outcome;
		expect(result.status).toBe("rejected");
		expect(result.reason?.message).toContain("2s run budget");
	});

	it("still ends a print-mode call whose kernel is booting when the budget expires", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager({ runBudgetSeconds: 1, hardLimitSeconds: 100 });
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: { getKernel: () => new Promise(() => {}) },
			cellTimeoutSeconds: 30,
			executeTool: vi.fn(),
			cellManager: manager,
		});
		let settledResult: { status: string; reason?: Error } | undefined;
		void settled(tool.execute("booting-cell", input(), undefined, undefined, fakeExtensionContext())).then(
			(value) => {
				settledResult = value;
			},
		);

		await vi.advanceTimersByTimeAsync(1_000);

		expect(settledResult?.status).toBe("rejected");
		expect(settledResult?.reason?.name).toBe("TimeoutError");
		expect(settledResult?.reason?.message).toContain("1s run budget");
		expect(manager.peek("booting-cell").state).toBe("cancelled");
	});

	it("lets a print-mode cell that finishes within the budget return its value", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager({ runBudgetSeconds: 2, hardLimitSeconds: 100 });
		const kernel = new FakeKernel([result("quick-cell", "42")]);
		const tool = createTool(manager, kernel);

		const value = await tool.execute("quick-cell", input(), undefined, undefined, fakeExtensionContext());

		expect(JSON.stringify(value.content)).toContain("42");
		expect(kernel.interrupts).toEqual([]);
	});
});
