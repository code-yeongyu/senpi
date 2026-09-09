import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	EvalDetachedCellManager,
	type EvalDetachedCellNotification,
	type EvalDetachedCellSnapshot,
	type EvalDetachedCellStatusEntry,
} from "../src/tool/detached-cell-manager.ts";
import { detachedKernelBusyError } from "../src/tool/detached-eval-result.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { EnabledEvalLanguages, EvalLanguage } from "../src/tool/types.ts";
import { errorResult, FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";

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

const directories: string[] = [];

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(directories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
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
		expect(manager.busyFor("js")).toMatchObject({ cellId: "detached-cell", state: "detached" });
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
		expect(manager.busyFor("js")).toMatchObject({ cellId: "stuck-bridge-cell", state: "detached" });

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
		expect(manager.busyFor("js")).toMatchObject({ state: "detached" });
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
		expect(manager.busyFor("js")).toBeUndefined();
	});

	it("returns a same-language busy error with the detached cell id and output tail while other languages continue", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager();
		const js = new FakeKernel([{ type: "text", stream: "stdout", data: "still computing\n" }]);
		const py = new FakeKernel([result("py-cell", "py-ok")]);
		const tool = createTool(manager, [
			["js", js],
			["py", py],
		]);

		await detach(tool, js, "busy-js");

		await expect(
			tool.execute(
				"blocked-js",
				{ language: "js", code: "sideEffect()", summary: "blocked js side effect" },
				undefined,
				undefined,
				interactiveContext(),
			),
		).rejects.toThrow(/busy running detached cell busy-js[\s\S]*still computing/u);
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
		expect(textOf(stoppedPython)).toContain("remains running; its existing variables are preserved.");

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
		expect(manager.busyFor("py")).toBeUndefined();
		expect(manager.busyFor("js")).toBeUndefined();
	});

	it("uses error timeout semantics by default in print/json modes and on explicit error", async () => {
		vi.useFakeTimers();
		const kernel = new FakeKernel([]);
		const started = kernel.deferNextRun();
		const tool = createTool(new EvalDetachedCellManager(), [["js", kernel]]);
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

		await expect(outcome).resolves.toMatchObject({ status: "rejected", error: { name: "TimeoutError" } });
		expect(kernel.interrupts).toEqual(["Cell timed out after 1000ms"]);
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
		expect(completionManager.busyFor("js")).toBeUndefined();

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
		expect(stopManager.busyFor("js")).toBeUndefined();
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
		expect(manager.busyFor("js")).toBeUndefined();
	});

	it("reports detached kernel crashes with the buffered tail and spills oversized notifications to an absolute path", async () => {
		vi.useFakeTimers();
		const artifactsDir = await mkdtemp(join(tmpdir(), "senpi-codemode-detach-"));
		directories.push(artifactsDir);
		const recorder = new NotificationRecorder();
		const manager = new EvalDetachedCellManager({ artifactsDir, notifier: recorder });
		const kernel = new FakeKernel([{ type: "text", stream: "stdout", data: `${"x".repeat(3_000)}\nlast tail\n` }]);
		const tool = createTool(manager, [["js", kernel]]);

		await detach(tool, kernel, "crashed-detached");
		expect(manager.busyFor("js")).toMatchObject({ state: "detached" });
		kernel.completeDeferredRun(errorResult("crashed-detached", "kernel crashed"));
		await manager.waitForTerminal("crashed-detached");
		expect(manager.peek("crashed-detached")).toMatchObject({ state: "failed" });
		await manager.flushNotifications();

		expect(recorder.notices).toHaveLength(1);
		expect(recorder.notices[0]?.content).toContain("kernel crashed");
		// Spill notices must carry the absolute spill path — the agent read tool cannot
		// resolve the local:// scheme (it is a kernel-helper-only scheme).
		const spillPath = join(artifactsDir, "local", "detached-eval-crashed-detached.log");
		expect(recorder.notices[0]?.content).toContain(spillPath);
		expect(recorder.notices[0]?.content).not.toContain("local://");
		expect(existsSync(spillPath)).toBe(true);
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

describe("detachedKernelBusyError", () => {
	const snapshot = {
		cellId: "cell-9",
		language: "py",
		state: "detached",
		outputTail: "still going",
		result: { content: [], details: { language: "py", durationMs: 0, toolCalls: [], truncated: false } },
		stateRetained: undefined,
	} as const satisfies EvalDetachedCellSnapshot;

	it("names each idle kernel and keeps busy language, cell id, peek, do-not-re-run, and output tail", () => {
		const message = detachedKernelBusyError(snapshot, ["js", "rb"]).message;
		expect(message).toBe(
			'The py eval kernel is busy running detached cell cell-9 - peek with eval({ action: "peek", cell_id: "cell-9" }) or continue this step in an idle kernel: js, rb. Do not re-run the busy cell. Current output tail:\nstill going',
		);
	});

	it("omits any idle-kernel claim when no other language is free", () => {
		const message = detachedKernelBusyError(snapshot, []).message;
		expect(message).not.toMatch(/idle kernel/iu);
		expect(message).toContain("The py eval kernel is busy running detached cell cell-9");
		expect(message).toContain('eval({ action: "peek", cell_id: "cell-9" })');
		expect(message).toMatch(/Do not re-run/u);
		expect(message).toContain("still going");
	});
});

describe("eval detached kernel busy error idle-kernel hint", () => {
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

	async function busyMessage(
		tool: ReturnType<typeof createBusyTool>,
		cellId: string,
		language: EvalLanguage,
	): Promise<string> {
		const rejection = await tool
			.execute(
				cellId,
				{ language, code: "sideEffect()", summary: `blocked ${language}` },
				undefined,
				undefined,
				interactiveContext(),
			)
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		expect(rejection).toBeInstanceOf(Error);
		return (rejection as Error).message;
	}

	function idleSection(message: string): string | undefined {
		const match = /idle kernel:\s*([^.]*)/u.exec(message);
		return match?.[1]?.trim();
	}

	it("names each idle enabled kernel when only one language is busy", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager();
		const py = new FakeKernel([{ type: "text", stream: "stdout", data: "py still computing\n" }]);
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
		const message = await busyMessage(tool, "blocked-py", "py");

		expect(message).toContain("The py eval kernel is busy running detached cell busy-py");
		expect(message).toContain('eval({ action: "peek", cell_id: "busy-py" })');
		expect(message).toMatch(/Do not re-run/u);
		expect(message).toContain("py still computing");
		const idle = idleSection(message);
		expect(idle).toBeDefined();
		expect(idle).toContain("js");
		expect(idle).toContain("rb");
		expect(idle).not.toContain("py");
		expect(message).toMatch(/continue this step in an idle kernel/u);

		await manager.stop("busy-py");
		await manager.flushNotifications();
	});

	it("omits any idle-kernel claim when only one language is enabled", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager();
		const js = new FakeKernel([{ type: "text", stream: "stdout", data: "js still computing\n" }]);
		const tool = createBusyTool(manager, [["js", js]], { js: true, py: false, rb: false, jl: false });

		await detachLanguage(tool, js, "busy-js", "js");
		const message = await busyMessage(tool, "blocked-js", "js");

		expect(message).toContain("The js eval kernel is busy running detached cell busy-js");
		expect(message).toContain('eval({ action: "peek", cell_id: "busy-js" })');
		expect(message).toMatch(/Do not re-run/u);
		expect(message).toContain("js still computing");
		expect(message).not.toMatch(/idle kernel/iu);

		await manager.stop("busy-js");
		await manager.flushNotifications();
	});

	it("names only remaining idle kernels when several languages are busy, and omits the claim when none are idle", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager();
		const js = new FakeKernel([{ type: "text", stream: "stdout", data: "js still computing\n" }]);
		const py = new FakeKernel([{ type: "text", stream: "stdout", data: "py still computing\n" }]);
		const rb = new FakeKernel([{ type: "text", stream: "stdout", data: "rb still computing\n" }]);
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

		const jsWhileRbIdle = await busyMessage(tool, "blocked-js", "js");
		expect(jsWhileRbIdle).toContain("The js eval kernel is busy running detached cell busy-js");
		expect(jsWhileRbIdle).toContain('eval({ action: "peek", cell_id: "busy-js" })');
		expect(jsWhileRbIdle).toMatch(/Do not re-run/u);
		expect(jsWhileRbIdle).toContain("js still computing");
		expect(idleSection(jsWhileRbIdle)).toBe("rb");

		const pyWhileRbIdle = await busyMessage(tool, "blocked-py", "py");
		expect(idleSection(pyWhileRbIdle)).toBe("rb");
		expect(pyWhileRbIdle).toContain("py still computing");

		await detachLanguage(tool, rb, "busy-rb", "rb");
		const jsWhenNoneIdle = await busyMessage(tool, "blocked-js-again", "js");
		expect(jsWhenNoneIdle).not.toMatch(/idle kernel/iu);
		expect(jsWhenNoneIdle).toContain("The js eval kernel is busy running detached cell busy-js");
		expect(jsWhenNoneIdle).toContain("js still computing");

		await manager.stop("busy-js");
		await manager.stop("busy-py");
		await manager.stop("busy-rb");
		await manager.flushNotifications();
	});
});
