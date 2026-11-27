import { afterEach, describe, expect, it, vi } from "vitest";
import { EvalDetachedCellManager } from "../src/tool/detached-cell-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { observeModelWrites } from "../src/written-files/model-writes.ts";
import { FakeKernel, FakeManager, result } from "./eval/fakes.ts";
import { openCell, outcomeFiles } from "./eval/written-files-barriers.ts";
import { reportedPaths, writtenFilesHarness } from "./eval/written-files-fakes.ts";

afterEach(() => {
	vi.useRealTimers();
});

// senpi#7232 review M1: a tool_call handler may redirect a model write; the hold must follow the file the call writes.
describe("a model write a tool_call handler redirected while a detached cell runs (senpi#7232)", () => {
	it("holds and records the redirected file, so the detached cell neither lists nor hooks it", async () => {
		vi.useFakeTimers();
		const harness = writtenFilesHarness();
		const { workspace } = harness;
		const sessionEvents = new Map<string, (event: unknown) => unknown>();
		observeModelWrites(
			(event, handler) => sessionEvents.set(event, handler),
			() => harness.writtenFiles,
		);
		const send = async (type: string, event: object) => await sessionEvents.get(type)?.({ type, ...event });
		const watching = await openCell(harness);
		const kernel = new FakeKernel([]);
		const manager = new EvalDetachedCellManager();
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
		const write = { toolCallId: "call-1", toolName: "write" };

		await send("tool_execution_start", { ...write, args: { path: "src/requested.ts", content: "export {};\n" } });
		await send("tool_call_ready", { ...write, input: { path: "src/redirected.ts", content: "export {};\n" } });
		workspace.write("src/redirected.ts", "export {};\n");
		workspace.write("src/late.ts", "export const late = 1;\n");
		kernel.completeDeferredRun(result("detached-writer", "undefined"));
		const settled = await manager.waitForTerminal("detached-writer");
		const hookedBeforeEnd = [...reportedPaths(harness)];
		await send("tool_execution_end", { ...write, isError: false });
		const afterEnd = await watching.settle(new AbortController().signal);
		workspace.write("src/redirected.ts", "export const later = 1;\n");
		const laterChange = outcomeFiles(await watching.settle(new AbortController().signal));
		watching.close();

		expect({
			files: settled.result.details.writtenFiles?.files,
			hookedBeforeEnd,
			afterEnd,
			laterChange,
			hooked: reportedPaths(harness),
		}).toEqual({
			files: ["src/late.ts"],
			hookedBeforeEnd: [workspace.absolute("src/late.ts")],
			afterEnd: undefined,
			laterChange: { files: ["src/redirected.ts"], total: 1, hooked: 1 },
			hooked: [workspace.absolute("src/late.ts"), workspace.absolute("src/redirected.ts")],
		});
	});
});
