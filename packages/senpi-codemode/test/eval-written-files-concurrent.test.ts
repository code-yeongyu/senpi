import { afterEach, describe, expect, it, vi } from "vitest";
import { EvalDetachedCellManager, type EvalDetachedCellNotification } from "../src/tool/detached-cell-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { observeModelWrites } from "../src/written-files/model-writes.ts";
import { FakeKernel, FakeManager, result } from "./eval/fakes.ts";
import { openCell, outcomeFiles } from "./eval/written-files-barriers.ts";
import { reportedPaths, type WrittenFilesHarness, writtenFilesHarness } from "./eval/written-files-fakes.ts";

afterEach(() => {
	vi.useRealTimers();
});

const DIAGNOSTIC = "(1,7): error TS2322: Type 'string' is not assignable to type 'number'.";

function diagnosingHarness(): WrittenFilesHarness {
	return writtenFilesHarness(async (report) => ({
		toolCallId: "cell/reported-1",
		result: { content: [...report.content, { type: "text", text: DIAGNOSTIC }] },
		failures: [],
	}));
}

/** Starts a cell that outlives its foreground window and returns once the call came back detached. */
async function detachCell(harness: WrittenFilesHarness, kernel: FakeKernel, manager: EvalDetachedCellManager) {
	const tool = createEvalTool({
		enabledLanguages: { js: true, py: false, rb: false, jl: false },
		kernelManager: new FakeManager([["js", kernel]]),
		cellTimeoutSeconds: 1,
		executeTool: vi.fn(),
		cellManager: manager,
		writtenFiles: harness.writtenFiles,
	});
	const started = kernel.deferNextRun();
	const call = tool.execute(
		"detached-writer",
		{ language: "js", code: "await build()", summary: "detached writer", on_timeout: "detach" },
		undefined,
		undefined,
		{ ...harness.ctx, mode: "tui" },
	);
	await started;
	await vi.advanceTimersByTimeAsync(1_000);
	await call;
}

// senpi#7232: a detached cell's files must reach the hooks and the model as a foreground cell's do.
describe("files a detached eval cell writes (senpi#7232)", () => {
	it("delivers the file list and the hook output with the completion notification", async () => {
		vi.useFakeTimers();
		const notices: EvalDetachedCellNotification[] = [];
		const manager = new EvalDetachedCellManager({ notifier: { notify: (cells) => notices.push(...cells) } });
		const harness = diagnosingHarness();
		const kernel = new FakeKernel([]);
		await detachCell(harness, kernel, manager);

		harness.workspace.write("src/late.ts", "const late: number = 'x';\n");
		kernel.completeDeferredRun(result("detached-writer", "undefined"));
		const settled = await manager.waitForTerminal("detached-writer");
		await manager.flushNotifications();

		expect(settled.result.details.writtenFiles).toEqual({ files: ["src/late.ts"], total: 1, hooked: 1 });
		expect(notices).toHaveLength(1);
		expect(notices[0]?.content).toContain(DIAGNOSTIC);
		expect(notices[0]?.content.split("\n")).toContain("- src/late.ts");
	});

	it("leaves out a file the model wrote with the write tool while the cell was running", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager();
		const harness = diagnosingHarness();
		const kernel = new FakeKernel([]);
		const sessionEvents = new Map<string, (event: unknown) => unknown>();
		observeModelWrites(
			(event, handler) => sessionEvents.set(event, handler),
			() => harness.writtenFiles,
		);
		await detachCell(harness, kernel, manager);

		harness.workspace.write("src/by-model.ts", "export {};\n");
		const call = {
			toolCallId: "call-1",
			toolName: "write",
			args: { path: "src/by-model.ts", content: "export {};\n" },
		};
		await sessionEvents.get("tool_execution_start")?.({ type: "tool_execution_start", ...call });
		await sessionEvents.get("tool_execution_end")?.({ type: "tool_execution_end", ...call, isError: false });
		harness.workspace.write("src/late.ts", "const late: number = 'x';\n");
		kernel.completeDeferredRun(result("detached-writer", "undefined"));
		const settled = await manager.waitForTerminal("detached-writer");

		expect(settled.result.details.writtenFiles?.files).toEqual(["src/late.ts"]);
		expect(harness.reported.map((report) => report.input.path)).toEqual([harness.workspace.absolute("src/late.ts")]);
	});

	// Seventh review: the model's call holds its file from its start, while its own hooks run, until its end.
	it("leaves out a file a model write has written but not yet ended when the detached cell settles in between", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager();
		const harness = diagnosingHarness();
		const { workspace } = harness;
		const kernel = new FakeKernel([]);
		const sessionEvents = new Map<string, (event: unknown) => unknown>();
		observeModelWrites(
			(event, handler) => sessionEvents.set(event, handler),
			() => harness.writtenFiles,
		);
		const watching = await openCell(harness);
		await detachCell(harness, kernel, manager);
		const call = { toolCallId: "call-1", toolName: "edit", args: { path: "src/by-model.ts" } };

		await sessionEvents.get("tool_execution_start")?.({ type: "tool_execution_start", ...call });
		workspace.write("src/by-model.ts", "export {};\n");
		workspace.write("src/late.ts", "const late: number = 'x';\n");
		kernel.completeDeferredRun(result("detached-writer", "undefined"));
		const settled = await manager.waitForTerminal("detached-writer");
		const hookedBeforeEnd = [...reportedPaths(harness)];
		await sessionEvents.get("tool_execution_end")?.({ type: "tool_execution_end", ...call, isError: false });
		const afterEnd = await watching.settle(new AbortController().signal);
		workspace.write("src/by-model.ts", "export const later = 1;\n");
		const laterChange = outcomeFiles(await watching.settle(new AbortController().signal));
		watching.close();

		expect({ files: settled.result.details.writtenFiles?.files, hookedBeforeEnd, afterEnd, laterChange }).toEqual({
			files: ["src/late.ts"],
			hookedBeforeEnd: [workspace.absolute("src/late.ts")],
			afterEnd: undefined,
			laterChange: { files: ["src/by-model.ts"], total: 1, hooked: 1 },
		});
	});
});
