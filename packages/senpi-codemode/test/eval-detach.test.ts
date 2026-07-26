import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvalDetachedCellManager, type EvalDetachedCellNotification } from "../src/tool/detached-cell-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
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
		{ language, code: "await forever", on_timeout: "detach" },
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
				{ language: "js", code: "sideEffect()" },
				undefined,
				undefined,
				interactiveContext(),
			),
		).rejects.toThrow(/busy running detached cell busy-js[\s\S]*still computing/u);
		await expect(
			tool.execute("py-cell", { language: "py", code: "answer = 42" }, undefined, undefined, interactiveContext()),
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
			{ language: "js", code: "await forever" },
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
			{ language: "js", code: "return 1", on_timeout: "detach" },
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

	it("reports detached kernel crashes with the buffered tail and spills oversized notifications to local://", async () => {
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
		expect(recorder.notices[0]?.content).toContain("local://detached-eval-crashed-detached.log");
		expect(existsSync(join(artifactsDir, "local", "detached-eval-crashed-detached.log"))).toBe(true);
	});
});
