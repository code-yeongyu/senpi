import type { AgentToolResult } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvalDetachedCellManager, type EvalDetachedCellNotification } from "../src/tool/detached-cell-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { EvalToolDetails } from "../src/tool/types.ts";
import { FakeKernel, FakeManager, fakeExtensionContext } from "./eval/fakes.ts";

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

describe("eval hard limit", () => {
	it("kills a detached cell that outlives the hard limit", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager({ hardLimitSeconds: 2 });
		const kernel = new FakeKernel([]);
		const cell = manager.create("runaway-cell", input());
		manager.markRunning(cell, kernel, liveResultFor("still computing"));
		manager.detach(cell);

		await vi.advanceTimersByTimeAsync(1_999);
		expect(kernel.interrupts).toEqual([]);
		expect(manager.peek("runaway-cell").state).toBe("detached");

		await vi.advanceTimersByTimeAsync(1);

		expect(kernel.interrupts).toHaveLength(1);
		expect(manager.peek("runaway-cell").state).toBe("cancelled");
		expect(manager.peek("runaway-cell").hardLimitSeconds).toBe(2);
		expect(manager.busyFor("js")).toBeUndefined();
	});

	it("tells the main agent the cell was killed by the hard limit", async () => {
		vi.useFakeTimers();
		const recorder = new NotificationRecorder();
		const manager = new EvalDetachedCellManager({ hardLimitSeconds: 2, notifier: recorder });
		const kernel = new FakeKernel([]);
		const cell = manager.create("notified-cell", input());
		manager.markRunning(cell, kernel, liveResultFor("buffered print"));
		manager.detach(cell);

		await vi.advanceTimersByTimeAsync(2_000);
		await manager.flushNotifications();

		expect(recorder.notices).toHaveLength(1);
		const content = recorder.notices[0]?.content ?? "";
		expect(recorder.notices[0]?.cellId).toBe("notified-cell");
		expect(content).toContain("notified-cell");
		expect(content).toContain("hard limit");
		expect(content).toContain("buffered print");
	});

	it("kills a cell whose idle watchdog is paused by bridge tool calls", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager({ hardLimitSeconds: 2 });
		const kernel = new FakeKernel([]);
		const killed: Error[] = [];
		const cell = manager.create("bridge-bound-cell", input());
		manager.markRunning(cell, kernel, liveResultFor("tool calls"), (error) => killed.push(error));

		await vi.advanceTimersByTimeAsync(2_000);

		expect(killed).toHaveLength(1);
		expect(killed[0]?.message).toContain("hard limit");
		expect(killed[0]?.message).toContain("bridge-bound-cell");
		expect(manager.peek("bridge-bound-cell").state).toBe("cancelled");
		// The still-awaited CellExecution owns interrupting the kernel and rejecting its own tool call,
		// so the manager must not fire a second interrupt at it.
		expect(kernel.interrupts).toEqual([]);
	});

	it("kills a foreground cell itself when no execution owns it yet", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager({ hardLimitSeconds: 2 });
		const kernel = new FakeKernel([]);
		const cell = manager.create("orphan-cell", input());
		manager.markRunning(cell, kernel, liveResultFor("booted"));

		await vi.advanceTimersByTimeAsync(2_000);

		expect(kernel.interrupts).toHaveLength(1);
		expect(kernel.interrupts[0]).toContain("hard limit");
		expect(manager.peek("orphan-cell").state).toBe("cancelled");
	});

	it("never kills a cell that settles before the limit", async () => {
		vi.useFakeTimers();
		const recorder = new NotificationRecorder();
		const manager = new EvalDetachedCellManager({ hardLimitSeconds: 2, notifier: recorder });
		const kernel = new FakeKernel([]);
		const cell = manager.create("fast-cell", input());
		manager.markRunning(cell, kernel, liveResultFor("done"));
		manager.detach(cell);
		manager.complete(cell, liveResultFor("done")());

		await vi.advanceTimersByTimeAsync(10_000);
		await manager.flushNotifications();

		expect(kernel.interrupts).toEqual([]);
		expect(manager.peek("fast-cell").state).toBe("completed");
		expect(manager.peek("fast-cell").hardLimitSeconds).toBeUndefined();
		expect(recorder.notices).toHaveLength(1);
		expect(recorder.notices[0]?.content).not.toContain("hard limit");
	});

	it("lets an explicit longer timeout raise the effective hard limit", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager({ hardLimitSeconds: 2 });
		const kernel = new FakeKernel([]);
		const cell = manager.create("explicit-cell", input({ timeout: 5 }));
		manager.markRunning(cell, kernel, liveResultFor("long by request"));
		manager.detach(cell);

		await vi.advanceTimersByTimeAsync(4_999);
		expect(kernel.interrupts).toEqual([]);

		await vi.advanceTimersByTimeAsync(1);

		expect(kernel.interrupts).toHaveLength(1);
		expect(manager.peek("explicit-cell").hardLimitSeconds).toBe(5);
	});

	it("delivers the hard-limit notice through the real eval tool path", async () => {
		vi.useFakeTimers();
		const recorder = new NotificationRecorder();
		const manager = new EvalDetachedCellManager({ hardLimitSeconds: 3, notifier: recorder });
		const kernel = new FakeKernel([{ type: "text", stream: "stdout", data: "partial output\n" }]);
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: new FakeManager([["js", kernel]]),
			cellTimeoutSeconds: 1,
			executeTool: vi.fn(),
			cellManager: manager,
		});
		const started = kernel.deferNextRun();
		const execution = tool.execute("tool-path-cell", { ...input(), on_timeout: "detach" }, undefined, undefined, {
			...fakeExtensionContext(),
			mode: "tui" as const,
		});
		await started;
		await vi.advanceTimersByTimeAsync(1_000);
		await execution;
		expect(manager.peek("tool-path-cell").state).toBe("detached");

		await vi.advanceTimersByTimeAsync(2_000);
		await manager.flushNotifications();

		expect(manager.peek("tool-path-cell").state).toBe("cancelled");
		expect(recorder.notices[0]?.content).toContain("hard limit");
		expect(recorder.notices[0]?.content).toContain("partial output");
	});
});
