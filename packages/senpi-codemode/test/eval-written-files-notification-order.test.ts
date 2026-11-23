import type { ExtensionToolContext } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvalDetachedCellManager, type EvalDetachedCellNotification } from "../src/tool/detached-cell-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { FakeKernel, SingleKernelManager } from "./eval/fakes.ts";
import { gate } from "./eval/written-files-barriers.ts";
import { writtenFilesHarness } from "./eval/written-files-fakes.ts";

afterEach(() => {
	vi.useRealTimers();
});

// senpi#7232 review M2: one detached cell's slow write hook must not hold back another cell's notification.
describe("detached notifications while another cell's write hook runs (senpi#7232)", () => {
	it("delivers a cell that wrote nothing while the first cell's hook is held, then the first with its files", async () => {
		vi.useFakeTimers();
		const harness = writtenFilesHarness();
		const hookStarted = gate();
		const releaseHook = gate();
		const quietNotified = gate();
		const notices: EvalDetachedCellNotification[] = [];
		const manager = new EvalDetachedCellManager({
			notifier: {
				notify: (cells) => {
					notices.push(...cells);
					if (cells.some((cell) => cell.cellId === "quiet")) quietNotified.open();
				},
			},
		});
		const ctx: ExtensionToolContext = {
			...harness.ctx,
			mode: "tui",
			reportToolResult: async () => {
				hookStarted.open();
				await releaseHook.opened;
				return { toolCallId: "writer/reported-1", result: undefined, failures: [] };
			},
		};
		const detach = async (cellId: string) => {
			const kernel = new FakeKernel([]);
			const tool = createEvalTool({
				enabledLanguages: { js: true, py: false, rb: false, jl: false },
				kernelManager: new SingleKernelManager(kernel),
				cellTimeoutSeconds: 1,
				executeTool: vi.fn(),
				cellManager: manager,
				writtenFiles: harness.writtenFiles,
			});
			const started = kernel.deferNextRun();
			const call = tool.execute(
				cellId,
				{ language: "js", code: "await work()", summary: cellId, on_timeout: "detach" },
				undefined,
				undefined,
				ctx,
			);
			await started;
			await vi.advanceTimersByTimeAsync(1_000);
			await call;
			return () => kernel.completeDeferredRun({ type: "result", cellId, ok: true, durationMs: 0 });
		};
		const finishWriter = await detach("writer");
		const finishQuiet = await detach("quiet");

		harness.workspace.write("src/a.ts", "export const a = 1;\n");
		finishWriter();
		await hookStarted.opened;
		finishQuiet();
		await quietNotified.opened;
		const whileHeld = notices.map((notice) => notice.cellId);
		releaseHook.open();
		await manager.flushNotifications();

		expect({
			whileHeld,
			delivered: notices.map((notice) => notice.cellId),
			writerLines: notices.find((notice) => notice.cellId === "writer")?.content.split("\n"),
		}).toEqual({
			whileHeld: ["quiet"],
			delivered: ["quiet", "writer"],
			writerLines: expect.arrayContaining(["- src/a.ts"]),
		});
	});
});
