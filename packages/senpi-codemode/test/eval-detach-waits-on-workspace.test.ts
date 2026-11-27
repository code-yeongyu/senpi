import type { AgentToolResult } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeEvalControl } from "../src/tool/detached-eval-result.ts";
import { EvalDetachedCellManager } from "../src/tool/detached-cell-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { renderEvalResult } from "../src/tool/render.ts";
import type { EvalToolDetails } from "../src/tool/types.ts";
import { WrittenFiles } from "../src/written-files/written-files.ts";
import { plainTheme, resultContext, stripAnsi } from "./eval-render-fixtures.ts";
import { FakeKernel, result, SingleKernelManager } from "./eval/fakes.ts";
import { gate } from "./eval/written-files-barriers.ts";
import { writtenFilesHarness } from "./eval/written-files-fakes.ts";

// senpi#7535: before its kernel runs a cell, the cell waits for the written-files scan of the workspace. A cell
// detached during that wait said it waited for its kernel to be ready, although the kernel was ready.

const SCAN = "reading the workspace's files before the js kernel runs it";

afterEach(() => {
	vi.useRealTimers();
});

function textOf(value: AgentToolResult<unknown>): string {
	return value.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

/** One cell held by the scan until it detaches; `repaint` renders its live row on every update, as the TUI does. */
async function heldScan(repaint: boolean) {
	vi.useFakeTimers();
	const harness = writtenFilesHarness();
	const scanHeld = gate();
	const writtenFiles = new WrittenFiles({
		cwd: harness.workspace.cwd,
		artifactsDir: harness.workspace.absolute("artifacts"),
		git: async (args, options) => {
			await scanHeld.opened;
			return await harness.workspace.git(args, options);
		},
		fs: harness.workspace.fs,
	});
	const kernel = new FakeKernel([]);
	const manager = new EvalDetachedCellManager({ notifier: { notify: () => {} } });
	const updates: string[] = [];
	const repaints = vi.fn();
	let row: ReturnType<typeof renderEvalResult> | undefined;
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
		(update: AgentToolResult<EvalToolDetails>) => {
			updates.push(JSON.stringify(update));
			if (repaint)
				row = renderEvalResult(update, { expanded: false, isPartial: true }, plainTheme(), {
					...resultContext({ invalidate: repaints }),
					toolCallId: "scanning",
				});
		},
		{ ...harness.ctx, mode: "tui" },
	);
	try {
		await vi.advanceTimersByTimeAsync(900);
		const rowWhileHeld = row?.render(200).map(stripAnsi).join("\n");
		await vi.advanceTimersByTimeAsync(100);
		const answer = textOf(await execution);
		const listed = textOf(await executeEvalControl(manager, { action: "list" }));
		const peeked = textOf(manager.peek("scanning").result);
		return { answer, listed, peeked, updates: [...updates], rowWhileHeld, repainted: repaints.mock.calls.length };
	} finally {
		scanHeld.open();
		await started;
		kernel.completeDeferredRun(result("scanning", "done"));
		await manager.waitForTerminal("scanning");
		await manager.dispose();
	}
}

describe("a cell detached while the workspace scan holds it (senpi#7535)", () => {
	it("names the workspace scan, not the kernel, in the detach answer, the list and a peek", async () => {
		const run = await heldScan(false);

		expect(run.answer).toContain(SCAN);
		expect(run.answer).not.toContain("kernel to be ready");
		expect(run.listed).toContain(SCAN);
		expect(run.peeked).toContain(SCAN);
		expect(run.updates.map((update) => textOf(JSON.parse(update)))).toEqual([
			"waiting for the js kernel to be ready",
		]);
	});

	it("names the scan in the live row by repainting it, with the event stream byte-identical to an unrendered run", async () => {
		const rendered = await heldScan(true);
		const unrendered = await heldScan(false);

		expect(rendered.repainted).toBeGreaterThan(0);
		expect(rendered.rowWhileHeld).toContain(SCAN);
		expect(rendered.updates).toEqual(unrendered.updates);
	});
});
