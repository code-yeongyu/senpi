import type { AgentToolResult } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeEvalControl } from "../src/tool/detached-eval-result.ts";
import { EvalDetachedCellManager } from "../src/tool/detached-cell-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { WrittenFiles } from "../src/written-files/written-files.ts";
import { FakeKernel, result, SingleKernelManager } from "./eval/fakes.ts";
import { gate } from "./eval/written-files-barriers.ts";
import { writtenFilesHarness } from "./eval/written-files-fakes.ts";

// senpi#7535: before its kernel runs a cell, the cell waits for the written-files scan of the workspace. A cell
// detached during that wait said it waited for its kernel to be ready, although the kernel was ready.

afterEach(() => {
	vi.useRealTimers();
});

function textOf(value: AgentToolResult<unknown>): string {
	return value.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

describe("a cell detached while the workspace scan holds it (senpi#7535)", () => {
	it("names the workspace scan, not the kernel, in the detach answer, the list and the live update", async () => {
		vi.useFakeTimers();
		const harness = writtenFilesHarness();
		const scanHeld = gate();
		const writtenFiles = new WrittenFiles({
			cwd: harness.workspace.cwd,
			artifactsDir: harness.workspace.absolute("artifacts"),
			git: async (args) => {
				await scanHeld.opened;
				return await harness.workspace.git(args);
			},
			fs: harness.workspace.fs,
		});
		const kernel = new FakeKernel([]);
		const manager = new EvalDetachedCellManager({ notifier: { notify: () => {} } });
		const updates: string[] = [];
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: new SingleKernelManager(kernel),
			cellTimeoutSeconds: 1,
			executeTool: vi.fn(),
			cellManager: manager,
			writtenFiles,
		});
		const started = kernel.deferNextRun();
		const execution = tool.execute(
			"scanning",
			{ language: "js", code: "await forever", summary: "held by the scan", on_timeout: "detach" },
			undefined,
			(update) => updates.push(textOf(update)),
			{ ...harness.ctx, mode: "tui" },
		);
		try {
			await vi.advanceTimersByTimeAsync(1_000);
			const answer = textOf(await execution);
			const listed = textOf(await executeEvalControl(manager, { action: "list" }));

			expect(answer).toContain("reading the workspace's files before the js kernel runs it");
			expect(answer).not.toContain("kernel to be ready");
			expect(listed).toContain("reading the workspace's files before the js kernel runs it");
			expect(
				updates.some((text) => text.includes("reading the workspace's files before the js kernel runs it")),
			).toBe(true);
		} finally {
			scanHeld.open();
			await started;
			kernel.completeDeferredRun(result("scanning", "done"));
			await manager.waitForTerminal("scanning");
			await manager.dispose();
		}
	});
});
