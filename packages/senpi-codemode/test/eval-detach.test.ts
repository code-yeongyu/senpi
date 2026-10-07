import type { AgentToolResult } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CellExecution } from "../src/tool/cell-execution.ts";
import {
	EvalDetachedCellManager,
	type EvalDetachedCellNotification,
	type EvalDetachedCellSnapshot,
	type EvalDetachedCellStatusEntry,
} from "../src/tool/detached-cell-manager.ts";
import { resultForDetachedState } from "../src/tool/detached-eval-result.ts";
import type { EvalExecutionEventPayload } from "../src/tool/eval-execution-event.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { EnabledEvalLanguages, EvalLanguage } from "../src/tool/types.ts";
import {
	DelayedKernelManager,
	errorResult,
	FakeKernel,
	FakeManager,
	fakeExtensionContext,
	result,
} from "./eval/fakes.ts";
import { QueuedFakeKernel } from "./eval/queued-fake.ts";

type TextContent = Extract<AgentToolResult<unknown>["content"][number], { type: "text" }>;

class NotificationRecorder {
	readonly batches: EvalDetachedCellNotification[][] = [];

	notify(cells: readonly EvalDetachedCellNotification[]): void {
		this.batches.push([...cells]);
	}

	get notices(): EvalDetachedCellNotification[] {
		return this.batches.flat();
	}
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function textOf(result: AgentToolResult<unknown>): string {
	const texts: string[] = [];
	for (const part of result.content as readonly TextContent[]) {
		if (part.type === "text") texts.push(part.text);
	}
	return texts.join("\n");
}

function interactiveContext() {
	return { ...fakeExtensionContext(), mode: "tui" as const };
}

function createTool(manager: EvalDetachedCellManager, entries: Array<readonly [string, FakeKernel]>) {
	return createEvalTool({
		enabledLanguages: { js: true, py: true, rb: false, jl: false },
		kernelManager: new FakeManager(entries),
		cellTimeoutSeconds: 1,
		executeTool: vi.fn(),
		cellManager: manager,
	});
}

async function detach(
	tool: ReturnType<typeof createTool>,
	kernel: FakeKernel,
	cellId: string,
	language: "js" | "py" = "js",
): Promise<AgentToolResult<unknown>> {
	const started = kernel.deferNextRun();
	const execution = tool.execute(
		cellId,
		{ language, code: "await forever", summary: "detach long-running cell", on_timeout: "detach" },
		undefined,
		undefined,
		interactiveContext(),
	);
	await started;
	await vi.advanceTimersByTimeAsync(1_000);
	return await execution;
}

describe("eval detached cells", () => {
	it("detaches a pure-compute timeout without interrupting the running kernel", async () => {
		vi.useFakeTimers();
		const recorder = new NotificationRecorder();
		const manager = new EvalDetachedCellManager({ notifier: recorder });
		const kernel = new FakeKernel([]);
		const tool = createTool(manager, [["js", kernel]]);

		const detached = await detach(tool, kernel, "detached-cell");

		expect(textOf(detached)).toContain("detached-cell");
		expect(kernel.interrupts).toEqual([]);
		expect(manager.liveCells("js")).toMatchObject([{ cellId: "detached-cell", state: "detached" }]);
		await manager.stop("detached-cell");
		await manager.flushNotifications();
	});

	it("detaches a cell parked in a bridge call that never resumes", async () => {
		vi.useFakeTimers();
		const recorder = new NotificationRecorder();
		const manager = new EvalDetachedCellManager({ notifier: recorder });
		// The cell pauses its watchdog for a host tool call (e.g. dag-wait) that never sends timeout-resume.
		const kernel = new FakeKernel([{ type: "status", event: { op: "timeout-pause" } }]);
		const tool = createTool(manager, [["js", kernel]]);

		const started = kernel.deferNextRun();
		const execution = tool.execute(
			"stuck-bridge-cell",
			{ language: "js", code: "await tool.dag_wait({})", summary: "stuck bridge", on_timeout: "detach" },
			undefined,
			undefined,
			interactiveContext(),
		);
		await started;

		// Before the fix the paused watchdog was cleared outright, so this cell stayed pending forever
		// and the agent loop never got its turn back.
		await vi.advanceTimersByTimeAsync(600_000);

		const detached = await execution;
		expect(textOf(detached)).toContain("stuck-bridge-cell");
		expect(manager.liveCells("js")).toMatchObject([{ cellId: "stuck-bridge-cell", state: "detached" }]);

		await manager.stop("stuck-bridge-cell");
		await manager.flushNotifications();
	});

	it("injects one completion notification with buffered output, final value, and state-persistence guidance", async () => {
		vi.useFakeTimers();
		const recorder = new NotificationRecorder();
		const manager = new EvalDetachedCellManager({ notifier: recorder });
		const kernel = new FakeKernel([{ type: "text", stream: "stdout", data: "buffered print\n" }]);
		const tool = createTool(manager, [["js", kernel]]);

		await detach(tool, kernel, "complete-after-detach");
		expect(manager.liveCells("js")).toMatchObject([{ state: "detached" }]);
		kernel.completeDeferredRun(result("complete-after-detach", "42"));
		await manager.waitForTerminal("complete-after-detach");
		expect(manager.peek("complete-after-detach")).toMatchObject({ state: "completed" });
		await manager.flushNotifications();

		expect(recorder.batches).toHaveLength(1);
		expect(recorder.notices).toEqual([
			expect.objectContaining({
				cellId: "complete-after-detach",
				content: expect.stringContaining("buffered print"),
			}),
		]);
		expect(recorder.notices[0]?.content).toContain("42");
		expect(recorder.notices[0]?.content).toContain(
			"Kernel state updated - variables are available to the next eval cell.",
		);
		expect(manager.liveCells("js")).toEqual([]);
	});

	it("queues same-language work while a detached cell and other languages continue", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager();
		const js = new QueuedFakeKernel();
		const py = new FakeKernel([result("py-cell", "py-ok")]);
		const tool = createTool(manager, [
			["js", js],
			["py", py],
		]);

		await detach(tool, js, "busy-js");

		const admitted = js.admitted("queued-js");
		const queued = tool.execute(
			"queued-js",
			{ language: "js", code: "sideEffect()", summary: "queued js side effect" },
			undefined,
			undefined,
			interactiveContext(),
		);
		await admitted;
		expect(manager.peek("queued-js")).toMatchObject({ state: "queued", queuedBehind: ["busy-js"] });
		await manager.stop("queued-js");
		await queued;
		await expect(
			tool.execute(
				"py-cell",
				{ language: "py", code: "answer = 42", summary: "compute answer in python" },
				undefined,
				undefined,
				interactiveContext(),
			),
		).resolves.toSatisfy((value: AgentToolResult<unknown>) => textOf(value).includes("py-ok"));

		await manager.stop("busy-js");
		await manager.flushNotifications();
	});

	it("returns queued-detached same-language work and notifies once each in A then B order", async () => {
		vi.useFakeTimers();
		const recorder = new NotificationRecorder();
		const manager = new EvalDetachedCellManager({ notifier: recorder });
		const js = new QueuedFakeKernel();
		const tool = createTool(manager, [["js", js]]);
		const updates = vi.fn();
		await detach(tool, js, "A");
		const admitted = js.admitted("B");
		const execution = tool.execute(
			"B",
			{ language: "js", code: "next()", summary: "queued B" },
			undefined,
			updates,
			interactiveContext(),
		);
		await admitted;
		try {
			expect(updates).toHaveBeenCalledWith(
				expect.objectContaining({
					details: expect.objectContaining({
						cells: [expect.objectContaining({ status: "queued", queuedBehind: ["A"] })],
					}),
				}),
			);
			await vi.advanceTimersByTimeAsync(1_000);
			expect((await execution).details.cells?.[0]).toMatchObject({ status: "queued", queuedBehind: ["A"] });
			const aTerminal = manager.waitForTerminal("A");
			const bStarted = js.started("B");
			js.completeDeferredRun(result("A", "first"));
			await aTerminal;
			await bStarted;
			const bTerminal = manager.waitForTerminal("B");
			js.completeDeferredRun(result("B", "second"));
			await bTerminal;
			await manager.flushNotifications();
			expect(recorder.notices.map((notice) => notice.cellId)).toEqual(["A", "B"]);
			expect(manager.liveCells()).toEqual([]);
		} finally {
			await manager.dispose();
		}
	});

	it("supports peek and stop, retaining Python state and reporting JavaScript VM loss", async () => {
		vi.useFakeTimers();
		const recorder = new NotificationRecorder();
		const manager = new EvalDetachedCellManager({ notifier: recorder });
		const py = new FakeKernel([{ type: "text", stream: "stdout", data: "x = 42\n" }]);
		const js = new FakeKernel([]);
		js.stateRetainedOnInterrupt = false;
		const tool = createTool(manager, [
			["py", py],
			["js", js],
		]);

		await detach(tool, py, "py-detached", "py");
		const peek = await tool.execute(
			"peek-py",
			{ action: "peek", cell_id: "py-detached" },
			undefined,
			undefined,
			interactiveContext(),
		);
		expect(textOf(peek)).toContain("x = 42");
		const stoppedPython = await tool.execute(
			"stop-py",
			{ action: "stop", cell_id: "py-detached" },
			undefined,
			undefined,
			interactiveContext(),
		);
		expect(textOf(stoppedPython)).toContain("was not restarted; variables from earlier cells are kept.");

		await detach(tool, js, "js-detached");
		const stoppedJavaScript = await tool.execute(
			"stop-js",
			{ action: "stop", cell_id: "js-detached" },
			undefined,
			undefined,
			interactiveContext(),
		);
		expect(textOf(stoppedJavaScript)).toContain("was restarted");
		expect(textOf(stoppedJavaScript)).toContain("lost");
		await manager.flushNotifications();
		expect(recorder.notices).toHaveLength(2);
		expect(manager.liveCells("py")).toEqual([]);
		expect(manager.liveCells("js")).toEqual([]);
	});

	it("never detaches in print/json modes: the cell blocks until its run budget kills it", async () => {
		vi.useFakeTimers();
		const kernel = new FakeKernel([]);
		const started = kernel.deferNextRun();
		const manager = new EvalDetachedCellManager({ runBudgetSeconds: 2 });
		const tool = createTool(manager, [["js", kernel]]);
		const execution = tool.execute(
			"print-timeout",
			{ language: "js", code: "await forever", summary: "print mode timeout" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);
		await started;
		const outcome = execution.then(
			() => ({ status: "fulfilled" as const }),
			(error: unknown) => ({ status: "rejected" as const, error }),
		);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(manager.liveCells("js")).toMatchObject([{ cellId: "print-timeout", state: "running" }]);
		expect(kernel.interrupts).toEqual([]);

		await vi.advanceTimersByTimeAsync(1_000);
		await expect(outcome).resolves.toMatchObject({ status: "rejected", error: { name: "TimeoutError" } });
		expect(kernel.interrupts).toEqual([expect.stringContaining("2s run budget")]);
	});

	it("settles timeout-vs-completion and stop-vs-completion races once with no stranded busy marker", async () => {
		vi.useFakeTimers();
		const completionRecorder = new NotificationRecorder();
		const completionManager = new EvalDetachedCellManager({ notifier: completionRecorder });
		const completionKernel = new FakeKernel([]);
		const completionTool = createTool(completionManager, [["js", completionKernel]]);
		const completionStarted = completionKernel.deferNextRun();
		const completion = completionTool.execute(
			"completion-wins",
			{ language: "js", code: "return 1", summary: "completion race", on_timeout: "detach" },
			undefined,
			undefined,
			interactiveContext(),
		);
		await completionStarted;
		completionKernel.completeDeferredRun(result("completion-wins", "1"));
		await completion;
		await vi.advanceTimersByTimeAsync(1_000);
		await completionManager.flushNotifications();
		expect(completionRecorder.notices).toHaveLength(0);
		expect(completionManager.liveCells("js")).toEqual([]);

		const stopRecorder = new NotificationRecorder();
		const stopManager = new EvalDetachedCellManager({ notifier: stopRecorder });
		const stopKernel = new FakeKernel([]);
		const stopTool = createTool(stopManager, [["js", stopKernel]]);
		await detach(stopTool, stopKernel, "stop-wins");
		await stopTool.execute(
			"stop",
			{ action: "stop", cell_id: "stop-wins" },
			undefined,
			undefined,
			interactiveContext(),
		);
		stopKernel.emit(result("stop-wins", "late"));
		await stopManager.flushNotifications();
		expect(stopRecorder.notices).toHaveLength(1);
		expect(stopManager.liveCells("js")).toEqual([]);
	});

	it("kills detached cells during session disposal and ignores late kernel messages after terminal state", async () => {
		vi.useFakeTimers();
		const recorder = new NotificationRecorder();
		const manager = new EvalDetachedCellManager({ notifier: recorder });
		const kernel = new FakeKernel([{ type: "text", stream: "stdout", data: "last tail\n" }]);
		const tool = createTool(manager, [["js", kernel]]);

		await detach(tool, kernel, "dispose-detached");
		await manager.dispose();
		kernel.emit(errorResult("dispose-detached", "late crash"));
		await manager.flushNotifications();

		expect(recorder.notices).toHaveLength(1);
		expect(recorder.notices[0]?.content).toContain("last tail");
		expect(manager.liveCells("js")).toEqual([]);
	});

	it("reports a detached kernel crash with the cell's whole result, as the foreground would", async () => {
		vi.useFakeTimers();
		const recorder = new NotificationRecorder();
		const manager = new EvalDetachedCellManager({ notifier: recorder });
		const kernel = new FakeKernel([
			{
				type: "text",
				stream: "stdout",
				data: `${Array.from({ length: 400 }, (_, i) => `row ${i} ${"x".repeat(40)}`).join("\n")}\nlast tail\n`,
			},
		]);
		const tool = createTool(manager, [["js", kernel]]);

		await detach(tool, kernel, "crashed-detached");
		kernel.completeDeferredRun(errorResult("crashed-detached", "kernel crashed"));
		await manager.waitForTerminal("crashed-detached");
		expect(manager.peek("crashed-detached")).toMatchObject({ state: "failed" });
		await manager.flushNotifications();

		expect(recorder.notices).toHaveLength(1);
		const content = recorder.notices[0]?.content ?? "";
		expect(content).toContain("kernel crashed");
		expect(content).toContain("row 0 ");
		expect(content).toContain("last tail");
		expect(content).not.toContain("local://");
	});
});

// senpi#1908: submission time, not kernel activation or bridge pauses, bounds foreground ownership.
describe("eval background capacity foreground window", () => {
	async function fixture() {
		vi.useFakeTimers();
		const recorder = new NotificationRecorder();
		const manager = new EvalDetachedCellManager({ maxDetachedCells: 1, notifier: recorder });
		const js = new QueuedFakeKernel();
		const py = new QueuedFakeKernel();
		const settled = vi.fn<(event: EvalExecutionEventPayload) => void>();
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: true, rb: false, jl: false },
			kernelManager: new FakeManager([
				["js", js],
				["py", py],
			]),
			cellTimeoutSeconds: 30,
			cellManager: manager,
			onCellSettled: settled,
			executeTool: vi.fn(),
		});
		const run = (id: string, language: "js" | "py") =>
			tool.execute(id, { language, code: "await gated", summary: id }, undefined, undefined, interactiveContext());
		const started = js.started("A");
		const owner = run("A", "js");
		await started;
		await vi.advanceTimersByTimeAsync(30_000);
		await owner;
		return { manager, recorder, js, py, settled, run };
	}

	it("keeps an at-cap cell alive at 30s and returns its normal foreground completion at 45s", async () => {
		const f = await fixture();
		const cancel = vi.spyOn(CellExecution.prototype, "cancel");
		const started = f.py.started("B");
		const finished = vi.fn();
		const execution = f.run("B", "py").then((value) => {
			finished(value);
			return value;
		});
		await started;
		try {
			await vi.advanceTimersByTimeAsync(30_000);
			expect(f.manager.peek("B").state).toBe("running");
			expect(cancel).not.toHaveBeenCalled();
			expect(finished).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(15_000);
			f.py.completeDeferredRun(result("B", "45", 45_000));
			const value = await execution;
			expect(value.details).toMatchObject({ durationMs: 45_000, cells: [{ status: "complete" }] });
			expect(value.details.isError).not.toBe(true);
			await vi.advanceTimersByTimeAsync(15_000);
			expect(cancel).not.toHaveBeenCalled();
			expect(f.manager.peek("A").state).toBe("detached");
			expect(f.recorder.notices).toEqual([]);
		} finally {
			await f.manager.dispose();
		}
	});

	it.each(["running", "queued", "paused-before-idle", "paused-after-idle"] as const)(
		"cancels only the at-cap %s cell at the submission-based 60s window with a typed capacity error",
		async (mode) => {
			const f = await fixture();
			const kernel = mode === "queued" ? f.js : f.py;
			const interrupt = vi.spyOn(kernel, "interrupt");
			const cancel = vi.spyOn(CellExecution.prototype, "cancel");
			const admitted = kernel.admitted("B");
			const finished = vi.fn();
			const execution = f
				.run("B", mode === "queued" ? "js" : "py")
				.then(
					(value) => ({ value }),
					(error: unknown) => ({ error }),
				)
				.then((outcome) => {
					finished(outcome);
					return outcome;
				});
			await admitted;
			try {
				await vi.advanceTimersByTimeAsync(29_000);
				if (mode === "paused-before-idle") kernel.emit({ type: "status", event: { op: "timeout-pause" } });
				await vi.advanceTimersByTimeAsync(1_000);
				expect(cancel).not.toHaveBeenCalled();
				expect(finished).not.toHaveBeenCalled();
				if (mode === "paused-after-idle") kernel.emit({ type: "status", event: { op: "timeout-pause" } });
				await vi.advanceTimersByTimeAsync(29_999);
				expect(cancel).not.toHaveBeenCalled();
				expect(finished).not.toHaveBeenCalled();
				await vi.advanceTimersByTimeAsync(1);
				expect(cancel.mock.calls[0]?.[0]).toMatchObject({ code: "eval_background_capacity_reached" });
				expect(cancel).toHaveBeenCalledOnce();
				expect(finished).toHaveBeenCalledOnce();
				expect(await execution).toMatchObject({
					value: {
						details: {
							isError: true,
							code: "eval_background_capacity_reached",
							cells: [{ status: "cancelled" }],
						},
					},
				});
				expect(f.manager.peek("B")).toMatchObject({ state: "cancelled", result: { details: { isError: true } } });
				expect(interrupt).toHaveBeenCalledExactlyOnceWith(expect.any(String), "B");
				expect(f.manager.peek("A").state).toBe("detached");
				expect(f.js.queueSnapshot()).toEqual({ activeCellId: "A", queuedCellIds: [] });
				expect(f.settled).toHaveBeenCalledExactlyOnceWith(
					expect.objectContaining({
						cellId: "B",
						ok: false,
						detached: false,
						queued_ms: mode === "queued" ? 60_000 : 0,
					}),
				);
				expect(f.recorder.notices).toEqual([]);
			} finally {
				if (kernel.queueSnapshot().activeCellId === "B") kernel.completeDeferredRun(result("B", "cleanup"));
				await f.manager.dispose();
				if (kernel.queueSnapshot().activeCellId === "B") kernel.completeDeferredRun(result("B", "cleanup"));
				await execution;
			}
		},
	);

	it("keeps an at-cap acquisition foreground until the window, then settles it without an interrupt target", async () => {
		const f = await fixture();
		const delayed = new DelayedKernelManager();
		const caller = new AbortController();
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: delayed,
			cellManager: f.manager,
			cellTimeoutSeconds: 30,
			executeTool: vi.fn(),
		});
		const cancel = vi.spyOn(CellExecution.prototype, "cancel");
		const execution = tool
			.execute("B", { language: "js", code: "1", summary: "B" }, caller.signal, undefined, interactiveContext())
			.then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			);
		await delayed.requested.promise;
		try {
			await vi.advanceTimersByTimeAsync(30_000);
			expect(cancel).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(30_000);
			expect(cancel.mock.calls[0]?.[0]).toMatchObject({ code: "eval_background_capacity_reached" });
			expect(await execution).toMatchObject({
				value: {
					details: {
						code: "eval_background_capacity_reached",
						isError: true,
						cells: [{ status: "cancelled" }],
					},
				},
			});
			expect(f.manager.peek("B").state).toBe("cancelled");
			expect(f.manager.peek("A").state).toBe("detached");
			expect(f.js.interrupts).toEqual([]);
		} finally {
			caller.abort(new Error("test cleanup"));
			delayed.acquired.resolve(f.js);
			await execution;
			await f.manager.dispose();
		}
	});

	it("retries detachment once at the window when capacity becomes available", async () => {
		const f = await fixture();
		const admitted = f.js.admitted("B");
		const execution = f.run("B", "js");
		await admitted;
		await vi.advanceTimersByTimeAsync(30_000);
		const ownerTerminal = f.manager.waitForTerminal("A");
		f.js.completeDeferredRun(result("A", "done"));
		await ownerTerminal;
		await vi.advanceTimersByTimeAsync(30_000);
		try {
			expect(f.manager.peek("B").state).toBe("detached");
			expect((await execution).details.cells?.[0]?.status).toBe("detached");
			expect(f.js.interrupts).toEqual([]);
		} finally {
			if (f.js.queueSnapshot().activeCellId === "B") f.js.completeDeferredRun(result("B", "cleanup"));
			await f.manager.dispose();
			await execution;
		}
	});
});

describe("eval detached cell status emissions", () => {
	function statusRecorder(): {
		readonly emissions: EvalDetachedCellStatusEntry[][];
		readonly onStatusChange: (entries: readonly EvalDetachedCellStatusEntry[]) => void;
	} {
		const emissions: EvalDetachedCellStatusEntry[][] = [];
		return { emissions, onStatusChange: (entries) => emissions.push([...entries]) };
	}

	async function detachSummarized(
		tool: ReturnType<typeof createTool>,
		kernel: FakeKernel,
		cellId: string,
		summary: string,
		language: "js" | "py" = "js",
	): Promise<void> {
		const started = kernel.deferNextRun();
		const execution = tool.execute(
			cellId,
			{ language, code: "await forever", summary, on_timeout: "detach" },
			undefined,
			undefined,
			interactiveContext(),
		);
		await started;
		await vi.advanceTimersByTimeAsync(1_000);
		await execution;
	}

	it("emits the detached cell on detach and an empty list once it completes", async () => {
		vi.useFakeTimers();
		const status = statusRecorder();
		const manager = new EvalDetachedCellManager({
			notifier: new NotificationRecorder(),
			onStatusChange: status.onStatusChange,
		});
		const kernel = new FakeKernel([]);
		const tool = createTool(manager, [["js", kernel]]);

		await detachSummarized(tool, kernel, "status-cell", "numpy feather rerun");

		expect(status.emissions).toEqual([
			[{ cellId: "status-cell", language: "js", summary: "numpy feather rerun", startedAtMs: expect.any(Number) }],
		]);

		kernel.completeDeferredRun(result("status-cell", "42"));
		await manager.waitForTerminal("status-cell");

		expect(status.emissions.at(-1)).toEqual([]);
		await manager.flushNotifications();
	});

	it("keeps the remaining detached cells listed when one of several is stopped", async () => {
		vi.useFakeTimers();
		const status = statusRecorder();
		const manager = new EvalDetachedCellManager({
			notifier: new NotificationRecorder(),
			onStatusChange: status.onStatusChange,
		});
		const js = new FakeKernel([]);
		const py = new FakeKernel([]);
		const tool = createTool(manager, [
			["js", js],
			["py", py],
		]);

		await detachSummarized(tool, js, "js-cell", "bundle build", "js");
		await detachSummarized(tool, py, "py-cell", "strip repairs", "py");

		expect(status.emissions.at(-1)).toEqual([
			{ cellId: "js-cell", language: "js", summary: "bundle build", startedAtMs: expect.any(Number) },
			{ cellId: "py-cell", language: "py", summary: "strip repairs", startedAtMs: expect.any(Number) },
		]);

		await manager.stop("js-cell");

		expect(status.emissions.at(-1)).toEqual([
			{ cellId: "py-cell", language: "py", summary: "strip repairs", startedAtMs: expect.any(Number) },
		]);
		await manager.stop("py-cell");
		await manager.flushNotifications();
	});

	it("omits the summary when the cell had none and stays silent for cells that never detach", async () => {
		vi.useFakeTimers();
		const status = statusRecorder();
		const manager = new EvalDetachedCellManager({
			notifier: new NotificationRecorder(),
			onStatusChange: status.onStatusChange,
		});
		const kernel = new FakeKernel([result("plain-cell", "1")]);
		const tool = createTool(manager, [["js", kernel]]);

		await tool.execute(
			"plain-cell",
			{ language: "js", code: "1", summary: "plain no detach" },
			undefined,
			undefined,
			interactiveContext(),
		);

		expect(status.emissions).toEqual([]);

		const detachedKernel = new FakeKernel([]);
		const detachedTool = createTool(manager, [["js", detachedKernel]]);
		const started = detachedKernel.deferNextRun();
		const execution = detachedTool.execute(
			"untitled-cell",
			{ language: "js", code: "await forever", summary: "untitled detached", on_timeout: "detach" },
			undefined,
			undefined,
			interactiveContext(),
		);
		await started;
		await vi.advanceTimersByTimeAsync(1_000);
		await execution;

		expect(status.emissions).toEqual([
			[{ cellId: "untitled-cell", language: "js", summary: "untitled detached", startedAtMs: expect.any(Number) }],
		]);
		await manager.stop("untitled-cell");
		await manager.flushNotifications();
	});
});

describe("queued cell result contract", () => {
	const snapshot = {
		cellId: "cell-9",
		language: "py",
		startedAtMs: 0,
		state: "detached",
		outputTail: "still going",
		result: { content: [], details: { language: "py", durationMs: 0, toolCalls: [], truncated: false } },
		stateRetained: undefined,
	} as const satisfies EvalDetachedCellSnapshot;

	it("preserves language and output when projecting a queued result", () => {
		const queued = resultForDetachedState(snapshot.result, "queued", 0, ["ahead"]);
		expect(queued.details.language).toBe("py");
		expect(queued.content).toEqual(snapshot.result.content);
		expect(queued.details.durationMs).toBe(0);
	});

	it("keeps queued status and predecessor ids without mutating the live result", () => {
		const source = {
			...snapshot.result,
			details: {
				...snapshot.result.details,
				cells: [{ index: 0, language: "py" as const, code: "1", output: "", status: "pending" as const }],
			},
		};
		const queued = resultForDetachedState(source, "queued", 0, ["ahead"]);
		expect(queued.details.cells?.[0]).toMatchObject({ status: "queued", queuedBehind: ["ahead"] });
		expect(source.details.cells[0]?.status).toBe("pending");
	});
});

describe("eval same-kernel queued admission", () => {
	function createBusyTool(
		manager: EvalDetachedCellManager,
		entries: Array<readonly [string, FakeKernel]>,
		enabledLanguages: EnabledEvalLanguages,
	) {
		return createEvalTool({
			enabledLanguages,
			kernelManager: new FakeManager(entries),
			cellTimeoutSeconds: 1,
			executeTool: vi.fn(),
			cellManager: manager,
		});
	}

	async function detachLanguage(
		tool: ReturnType<typeof createBusyTool>,
		kernel: FakeKernel,
		cellId: string,
		language: EvalLanguage,
	): Promise<void> {
		const started = kernel.deferNextRun();
		const execution = tool.execute(
			cellId,
			{ language, code: "await forever", summary: `detach ${language}`, on_timeout: "detach" },
			undefined,
			undefined,
			interactiveContext(),
		);
		await started;
		await vi.advanceTimersByTimeAsync(1_000);
		await execution;
	}

	async function assertQueued(
		tool: ReturnType<typeof createBusyTool>,
		manager: EvalDetachedCellManager,
		kernel: QueuedFakeKernel,
		cellId: string,
		language: EvalLanguage,
		ahead: string,
	): Promise<void> {
		const admitted = kernel.admitted(cellId);
		const execution = tool.execute(
			cellId,
			{ language, code: "sideEffect()", summary: `queued ${language}` },
			undefined,
			undefined,
			interactiveContext(),
		);
		await admitted;
		expect(manager.peek(cellId)).toMatchObject({ state: "queued", language, queuedBehind: [ahead] });
		expect(manager.peek(ahead).state).toBe("detached");
		await manager.stop(cellId);
		await execution;
		expect(kernel.interrupts).toEqual([]);
	}

	it("admits queued work when other enabled kernels are idle", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager();
		const py = new QueuedFakeKernel();
		const tool = createBusyTool(
			manager,
			[
				["py", py],
				["js", new FakeKernel([])],
				["rb", new FakeKernel([])],
			],
			{ js: true, py: true, rb: true, jl: false },
		);

		await detachLanguage(tool, py, "busy-py", "py");
		await assertQueued(tool, manager, py, "queued-py", "py", "busy-py");
		expect(manager.liveCells("js")).toEqual([]);
		expect(manager.liveCells("rb")).toEqual([]);

		await manager.stop("busy-py");
		await manager.flushNotifications();
	});

	it("admits queued work when only one language is enabled", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager();
		const js = new QueuedFakeKernel();
		const tool = createBusyTool(manager, [["js", js]], { js: true, py: false, rb: false, jl: false });

		await detachLanguage(tool, js, "busy-js", "js");
		await assertQueued(tool, manager, js, "queued-js", "js", "busy-js");

		await manager.stop("busy-js");
		await manager.flushNotifications();
	});

	it("admits queued work whether some or all other kernels are busy", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager();
		const js = new QueuedFakeKernel();
		const py = new QueuedFakeKernel();
		const rb = new QueuedFakeKernel();
		const tool = createBusyTool(
			manager,
			[
				["js", js],
				["py", py],
				["rb", rb],
			],
			{ js: true, py: true, rb: true, jl: false },
		);

		await detachLanguage(tool, js, "busy-js", "js");
		await detachLanguage(tool, py, "busy-py", "py");

		await assertQueued(tool, manager, js, "queued-js", "js", "busy-js");
		await assertQueued(tool, manager, py, "queued-py", "py", "busy-py");
		expect(manager.liveCells("rb")).toEqual([]);
		await detachLanguage(tool, rb, "busy-rb", "rb");
		await assertQueued(tool, manager, js, "queued-js-again", "js", "busy-js");
		expect(manager.liveCells()).toHaveLength(3);

		await manager.stop("busy-js");
		await manager.stop("busy-py");
		await manager.stop("busy-rb");
		await manager.flushNotifications();
	});
});
