import type { AgentToolResult } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatEvalCellStatus } from "../src/extension/eval-status.ts";
import type { WakeSourceState } from "../src/extension/wake-source-state.ts";
import {
	EvalDetachedCellManager,
	type EvalDetachedCellNotification,
	type EvalDetachedCellStatusEntry,
} from "../src/tool/detached-cell-manager.ts";
import type { EvalExecutionEventPayload } from "../src/tool/eval-execution-event.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { renderEvalResult } from "../src/tool/render.ts";
import type { EvalLanguage, EvalToolDetails } from "../src/tool/types.ts";
import { FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";
import { QueuedFakeKernel } from "./eval/queued-fake.ts";
import { renderLines, resultContext } from "./eval-render-fixtures.ts";

const managers: EvalDetachedCellManager[] = [];
afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.dispose();
	vi.useRealTimers();
});

function fixture(maxDetachedCells = 15) {
	vi.useFakeTimers();
	vi.setSystemTime(0);
	const notices: EvalDetachedCellNotification[] = [];
	const wake: WakeSourceState[] = [];
	const statuses: (readonly EvalDetachedCellStatusEntry[])[] = [];
	const events: EvalExecutionEventPayload[] = [];
	const manager = new EvalDetachedCellManager({
		maxDetachedCells,
		notifier: { notify: (batch) => notices.push(...batch) },
		onWakeSourceState: (state) => wake.push(state),
		onStatusChange: (entries) => statuses.push(entries),
	});
	managers.push(manager);
	const js = new QueuedFakeKernel();
	const py = new QueuedFakeKernel();
	const tool = createEvalTool({
		enabledLanguages: { js: true, py: true, rb: false, jl: false },
		kernelManager: new FakeManager([
			["js", js],
			["py", py],
		]),
		cellManager: manager,
		cellTimeoutSeconds: 1,
		executeTool: vi.fn(),
		onCellSettled: (event) => events.push(event),
	});
	const context = { ...fakeExtensionContext(), mode: "tui" as const };
	async function submit(cellId: string, language: EvalLanguage = "js", timeout?: number) {
		const kernel = language === "js" ? js : py;
		const admitted = kernel.admitted(cellId);
		const updates: AgentToolResult<EvalToolDetails>[] = [];
		const execution = tool.execute(
			cellId,
			{ language, code: cellId, summary: cellId, ...(timeout === undefined ? {} : { timeout }) },
			undefined,
			(update) => updates.push(update),
			context,
		);
		await Promise.race([admitted, execution]);
		return { execution, updates };
	}
	return { manager, js, py, submit, notices, wake, statuses, events };
}

// senpi#1908: same-kernel submissions are FIFO, not a per-language admission error.
describe("capped detached cells and queued admission", () => {
	it("creates queued run state before binding a kernel", () => {
		const f = fixture();
		const cell = f.manager.create("new", { language: "js", code: "1", summary: "new" });
		expect(cell.state).toBe("queued");
		expect(f.manager.liveCells()).toMatchObject([{ cellId: "new", state: "queued" }]);
	});
	it("creates queued cells and lists three detached cells across two kernels", async () => {
		const f = fixture();
		const a = await f.submit("A");
		await vi.advanceTimersByTimeAsync(1000);
		await a.execution;
		const b = await f.submit("B");
		expect(f.manager.peek("B")).toMatchObject({ state: "queued", queuedBehind: ["A"] });
		const c = await f.submit("C", "py");
		await vi.advanceTimersByTimeAsync(1000);
		await Promise.all([b.execution, c.execution]);
		expect(f.manager.liveCells().map((cell) => cell.cellId)).toEqual(["A", "B", "C"]);
		expect(f.manager.liveCells("js", { except: "A" })).toMatchObject([
			{ cellId: "B", state: "detached", queuedBehind: ["A"] },
		]);
		expect(f.wake.at(-1)?.activeCount).toBe(3);
		expect(f.statuses.at(-1)?.find((cell) => cell.cellId === "B")?.queuedBehind).toEqual(["A"]);
		expect(formatEvalCellStatus(f.statuses.at(-1) ?? [], Date.now())).toContain("queued");
	});

	it("keeps the third cell running in foreground at a cap of two", async () => {
		const f = fixture(2);
		const a = await f.submit("A");
		const b = await f.submit("B");
		await vi.advanceTimersByTimeAsync(1000);
		await Promise.all([a.execution, b.execution]);
		const detach = vi.spyOn(f.manager, "detach");
		const c = await f.submit("C", "py");
		await vi.advanceTimersByTimeAsync(1000);
		expect(detach.mock.results.at(-1)?.value).toBe(false);
		expect(f.manager.peek("C").state).toBe("running");
		expect(f.manager.liveCells()).toHaveLength(3);
		expect(f.py.interrupts).toEqual([]);
		f.py.completeDeferredRun(result("C", "c"));
		await c.execution;
		await f.manager.flushNotifications();
		expect(f.notices).toEqual([]);
	});

	it("dequeues stopped B without interrupting detached A or claiming kernel loss", async () => {
		const f = fixture();
		const a = await f.submit("A");
		await vi.advanceTimersByTimeAsync(1000);
		await a.execution;
		const b = await f.submit("B");
		const interrupt = vi.spyOn(f.js, "interrupt");
		const dequeue = vi.spyOn(f.js, "cancelQueued");
		const stopped = await f.manager.stop("B");
		expect(stopped).toMatchObject({ state: "cancelled", stateRetained: true });
		expect(stopped.interruptNote).toBeUndefined();
		expect(stopped.queuedBehind).toBeUndefined();
		expect(stopped.result.details.cells?.[0]?.queuedBehind).toBeUndefined();
		expect(dequeue).toHaveBeenCalledWith("B", expect.any(String));
		expect(interrupt).not.toHaveBeenCalled();
		expect(f.manager.peek("A").state).toBe("detached");
		await b.execution;
	});

	it("starts detached B through onStarted and notifies exactly once per detached settlement in order", async () => {
		const f = fixture();
		const a = await f.submit("A");
		const b = await f.submit("B");
		await vi.advanceTimersByTimeAsync(1000);
		await Promise.all([a.execution, b.execution]);
		const started = f.js.started("B");
		const terminalA = f.manager.waitForTerminal("A");
		f.js.completeDeferredRun(result("A", "a"));
		await Promise.all([terminalA, started]);
		expect(f.manager.peek("B").state).toBe("detached");
		expect(f.manager.peek("B").queuedBehind).toBeUndefined();
		const terminalB = f.manager.waitForTerminal("B");
		f.js.completeDeferredRun(result("B", "b"));
		await terminalB;
		await f.manager.flushNotifications();
		expect(f.notices.map((notice) => notice.cellId)).toEqual(["A", "B"]);
		expect(f.manager.list()).toMatchObject({ live: [], recent: [{ cellId: "A" }, { cellId: "B" }] });
		expect(f.events.find((event) => event.cellId === "B")?.queued_ms).toBe(1000);
	});

	it("disposes every detached cell, dequeuing waiters before interrupting active runs", async () => {
		const f = fixture();
		const a = await f.submit("A");
		const b = await f.submit("B");
		const c = await f.submit("C", "py");
		await vi.advanceTimersByTimeAsync(1000);
		await Promise.all([a.execution, b.execution, c.execution]);
		const started = vi.spyOn(f.manager, "markRunning");
		const dequeue = vi.spyOn(f.js, "cancelQueued");
		const interrupt = vi.spyOn(f.js, "interrupt");
		await f.manager.dispose();
		expect(dequeue).toHaveBeenCalledWith("B", expect.any(String));
		expect(interrupt).toHaveBeenCalledExactlyOnceWith(expect.any(String), "A");
		expect(started).not.toHaveBeenCalled();
		expect(f.notices.map((notice) => notice.cellId).sort()).toEqual(["A", "B", "C"]);
		expect(f.wake.at(-1)?.activeCount).toBe(0);
	});

	it("does not charge 400 seconds of queue wait, then expires B's own 300 second budget", async () => {
		const f = fixture();
		const a = await f.submit("A", "js", 1000);
		const b = await f.submit("B");
		await vi.advanceTimersByTimeAsync(400_000);
		await Promise.all([a.execution, b.execution]);
		expect(f.manager.peek("B")).toMatchObject({ state: "detached", queuedBehind: ["A"] });
		expect(f.manager.peek("B").result.details.durationMs).toBe(0);
		expect(f.js.interrupts).toEqual([]);
		const started = f.js.started("B");
		f.js.completeDeferredRun(result("A", "a"));
		await started;
		await vi.advanceTimersByTimeAsync(299_000);
		expect(f.manager.peek("B").result.details.durationMs).toBe(299_000);
		await vi.advanceTimersByTimeAsync(2000);
		expect(f.manager.peek("B")).toMatchObject({ state: "cancelled", runBudgetSeconds: 300 });
		expect(f.js.interrupts).toHaveLength(1);
	});

	it("routes A's text to A after B is submitted, and renders queued B with its predecessors", async () => {
		const f = fixture();
		const a = await f.submit("A");
		await vi.advanceTimersByTimeAsync(1000);
		await a.execution;
		const b = await f.submit("B");
		f.js.emit({ type: "text", stream: "stdout", data: "only-A\n" });
		expect(f.manager.peek("A").outputTail).toContain("only-A");
		expect(f.manager.peek("B").outputTail).not.toContain("only-A");
		const component = renderEvalResult(
			f.manager.peek("B").result,
			{ expanded: false, isPartial: true },
			undefined,
			resultContext(undefined, false),
		);
		const lines = renderLines(component).join("\n");
		expect(lines).toContain("○");
		expect(lines).toContain("queued behind A");
		await f.manager.stop("B");
		await b.execution;
	});

	it("expires a queued cell's hard limit from submission without interrupting its predecessor", async () => {
		const f = fixture();
		const a = await f.submit("A", "js", 4000);
		const b = await f.submit("B");
		await vi.advanceTimersByTimeAsync(1_800_000);
		await Promise.all([a.execution, b.execution]);
		expect(f.manager.peek("B")).toMatchObject({ state: "cancelled", hardLimitSeconds: 1800, stateRetained: true });
		expect(f.js.interrupts).toEqual([]);
		expect(f.manager.peek("A").state).toBe("detached");
	});
});
