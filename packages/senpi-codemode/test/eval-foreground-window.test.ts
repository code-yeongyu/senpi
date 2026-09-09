import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultCodemodeSettings, loadCodemodeSettings } from "../src/config/settings.ts";
import { EvalDetachedCellManager } from "../src/tool/detached-cell-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { FakeKernel, FakeManager, fakeExtensionContext } from "./eval/fakes.ts";

type TextContent = Extract<AgentToolResult<unknown>["content"][number], { type: "text" }>;

function textOf(resultValue: AgentToolResult<unknown>): string {
	const texts: string[] = [];
	for (const part of resultValue.content as readonly TextContent[]) {
		if (part.type === "text") texts.push(part.text);
	}
	return texts.join("\n");
}

function interactiveContext() {
	return { ...fakeExtensionContext(), mode: "tui" as const };
}

function createTool(manager: EvalDetachedCellManager, kernel: FakeKernel, foregroundWindowSeconds: number) {
	return createEvalTool({
		enabledLanguages: { js: true, py: false, rb: false, jl: false },
		kernelManager: new FakeManager([["js", kernel]]),
		cellTimeoutSeconds: 1,
		foregroundWindowSeconds,
		executeTool: vi.fn(),
		cellManager: manager,
	});
}

function trackSettlement(execution: Promise<AgentToolResult<EvalToolDetailsLike>>) {
	const state = { settled: false };
	void execution.then(
		() => {
			state.settled = true;
		},
		() => {
			state.settled = true;
		},
	);
	return state;
}

type EvalToolDetailsLike = unknown;

describe("eval foreground window", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("detaches an explicit long timeout at the foreground window instead of blocking for it", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager();
		const kernel = new FakeKernel([]);
		const tool = createTool(manager, kernel, 5);

		const started = kernel.deferNextRun();
		const execution = tool.execute(
			"fw-long-cell",
			{ language: "js", code: "await forever", summary: "long orchestration", timeout: 3600 },
			undefined,
			undefined,
			interactiveContext(),
		);
		await started;
		const settlement = trackSettlement(execution);

		await vi.advanceTimersByTimeAsync(4_999);
		expect(settlement.settled).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		expect(settlement.settled).toBe(true);
		const detached = await execution;
		expect(textOf(detached)).toContain("detached and is still running");
		expect(kernel.interrupts).toEqual([]);
		expect(manager.busyFor("js")).toMatchObject({ cellId: "fw-long-cell", state: "detached" });
		await manager.stop("fw-long-cell");
		await manager.flushNotifications();
	});

	it("still detaches at the explicit timeout when it is shorter than the window", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager();
		const kernel = new FakeKernel([]);
		const tool = createTool(manager, kernel, 5);

		const started = kernel.deferNextRun();
		const execution = tool.execute(
			"fw-short-cell",
			{ language: "js", code: "await forever", summary: "medium work", timeout: 3 },
			undefined,
			undefined,
			interactiveContext(),
		);
		await started;
		const settlement = trackSettlement(execution);

		await vi.advanceTimersByTimeAsync(2_999);
		expect(settlement.settled).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		expect(settlement.settled).toBe(true);
		const detached = await execution;
		expect(textOf(detached)).toContain("detached and is still running");
		expect(manager.busyFor("js")).toMatchObject({ cellId: "fw-short-cell", state: "detached" });
		await manager.stop("fw-short-cell");
		await manager.flushNotifications();
	});

	it("detaches a bridge-paused cell at the foreground window, not the default pause grace", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager();
		// The cell pauses its idle watchdog for a host bridge call (e.g. dag-wait) that never resumes.
		const kernel = new FakeKernel([{ type: "status", event: { op: "timeout-pause" } }]);
		const tool = createTool(manager, kernel, 2);

		const started = kernel.deferNextRun();
		const execution = tool.execute(
			"fw-bridge-cell",
			{ language: "js", code: "await tool.dag_wait({})", summary: "stuck bridge", timeout: 3600 },
			undefined,
			undefined,
			interactiveContext(),
		);
		await started;
		const settlement = trackSettlement(execution);

		await vi.advanceTimersByTimeAsync(1_999);
		expect(settlement.settled).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		expect(settlement.settled).toBe(true);
		const detached = await execution;
		expect(textOf(detached)).toContain("detached and is still running");
		await manager.stop("fw-bridge-cell");
		await manager.flushNotifications();
	});

	it("keeps an explicit on_timeout:error deadline unclamped by the foreground window", async () => {
		vi.useFakeTimers();
		const kernel = new FakeKernel([]);
		const tool = createTool(new EvalDetachedCellManager(), kernel, 2);

		const started = kernel.deferNextRun();
		const execution = tool.execute(
			"fw-error-cell",
			{ language: "js", code: "await forever", summary: "deadline-sensitive work", timeout: 3, on_timeout: "error" },
			undefined,
			undefined,
			interactiveContext(),
		);
		await started;
		const settlement = trackSettlement(execution);

		await vi.advanceTimersByTimeAsync(2_999);
		expect(settlement.settled).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		const outcome = await execution.then(
			() => ({ status: "fulfilled" as const }),
			(error: unknown) => ({ status: "rejected" as const, error }),
		);
		expect(outcome).toMatchObject({ status: "rejected", error: { name: "TimeoutError" } });
		expect(kernel.interrupts).toEqual(["Cell timed out after 3000ms"]);
	});

	it("keeps the default detach at cellTimeoutSeconds when no explicit timeout is given", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager();
		const kernel = new FakeKernel([]);
		const tool = createTool(manager, kernel, 5);

		const started = kernel.deferNextRun();
		const execution = tool.execute(
			"fw-default-cell",
			{ language: "js", code: "await forever", summary: "default budget" },
			undefined,
			undefined,
			interactiveContext(),
		);
		await started;
		const settlement = trackSettlement(execution);

		await vi.advanceTimersByTimeAsync(999);
		expect(settlement.settled).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		expect(settlement.settled).toBe(true);
		const detached = await execution;
		expect(textOf(detached)).toContain("detached and is still running");
		await manager.stop("fw-default-cell");
		await manager.flushNotifications();
	});

	it("defaults the foreground window to 60 seconds", () => {
		expect(defaultCodemodeSettings).toMatchObject({ foregroundWindowSeconds: 60 });
	});

	it("loads foregroundWindowSeconds from codemode.json", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-fw-"));
		try {
			const projectDir = join(root, "project");
			await mkdir(join(projectDir, ".senpi"), { recursive: true });
			await writeFile(join(projectDir, ".senpi", "codemode.json"), JSON.stringify({ foregroundWindowSeconds: 42 }));

			const loaded = await loadCodemodeSettings({ cwd: projectDir, homeDir: join(root, "home") });

			expect(loaded.warnings).toEqual([]);
			expect(loaded.settings).toMatchObject({ foregroundWindowSeconds: 42, cellTimeoutSeconds: 30 });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
