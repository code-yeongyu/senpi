import type { AgentToolResult } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvalDetachedCellManager } from "../src/tool/detached-cell-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { errorResult, FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";

type TextContent = Extract<AgentToolResult<unknown>["content"][number], { type: "text" }>;

afterEach(() => {
	vi.useRealTimers();
});

function textOf(toolResult: AgentToolResult<unknown>): string {
	const texts: string[] = [];
	for (const part of toolResult.content as readonly TextContent[]) {
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

async function run(
	tool: ReturnType<typeof createTool>,
	cellId: string,
	language: "js" | "py",
	code: string,
): Promise<AgentToolResult<unknown>> {
	return await tool.execute(
		cellId,
		{ language, code, summary: "reuse probe" },
		undefined,
		undefined,
		interactiveContext(),
	);
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
		{ language, code: "await forever", on_timeout: "detach", summary: "detach probe" },
		undefined,
		undefined,
		interactiveContext(),
	);
	await started;
	await vi.advanceTimersByTimeAsync(1_000);
	return await execution;
}

// Some providers issue per-message indexed tool call ids ("eval:0", "eval:1", ...)
// that repeat across assistant messages. The manager must treat a reused id whose
// previous cell reached a terminal state as a fresh cell instead of failing with
// "Eval cell <id> is already managed".
describe("eval cell id reuse", () => {
	it("runs a fresh cell when a tool call id is reused after the previous cell completed", async () => {
		const manager = new EvalDetachedCellManager();
		const kernel = new FakeKernel([result("eval:0", "first-ok")]);
		const tool = createTool(manager, [["js", kernel]]);

		const first = await run(tool, "eval:0", "js", "1 + 1");
		expect(textOf(first)).toContain("first-ok");

		kernel.replaceMessages([result("eval:0", "second-ok")]);
		const second = await run(tool, "eval:0", "js", "2 + 2");
		expect(textOf(second)).toContain("second-ok");
	});

	it("runs a fresh cell after a failed cell with the same id and peek follows the newest cell", async () => {
		const manager = new EvalDetachedCellManager();
		const kernel = new FakeKernel([errorResult("eval:0", "boom")]);
		const tool = createTool(manager, [["js", kernel]]);

		const first = await run(tool, "eval:0", "js", "explode()");
		expect(first.details).toMatchObject({ isError: true });

		kernel.replaceMessages([result("eval:0", "recovered")]);
		const second = await run(tool, "eval:0", "js", "1");
		expect(textOf(second)).toContain("recovered");

		const peek = await tool.execute(
			"peek-call",
			{ action: "peek", cell_id: "eval:0" },
			undefined,
			undefined,
			interactiveContext(),
		);
		expect(textOf(peek)).toContain("is completed");
	});

	it("rejects duplicate active ids even though distinct same-language ids can queue", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager();
		const kernel = new FakeKernel([{ type: "text", stream: "stdout", data: "still computing\n" }]);
		const tool = createTool(manager, [["js", kernel]]);

		await detach(tool, kernel, "eval:0");
		await expect(run(tool, "eval:0", "js", "again()")).rejects.toThrow(
			/previous call is still detached[\s\S]*peek[\s\S]*stop/u,
		);

		await manager.stop("eval:0");
		await manager.flushNotifications();
	});

	it("rejects reusing the id of a still-active cell with peek/stop guidance instead of the bare already-managed error", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager();
		const js = new FakeKernel([]);
		const py = new FakeKernel([result("eval:0", "py-ok")]);
		const tool = createTool(manager, [
			["js", js],
			["py", py],
		]);

		await detach(tool, js, "eval:0");
		const error = await run(tool, "eval:0", "py", "1").then(
			() => {
				throw new Error("expected the reuse of an active cell id to reject");
			},
			(reason: unknown) => reason,
		);
		if (!(error instanceof Error)) throw new Error("expected an Error rejection");
		expect(error.message).toMatch(/still detached/u);
		expect(error.message).toContain('eval({ action: "peek", cell_id: "eval:0" })');
		expect(error.message).toContain('eval({ action: "stop", cell_id: "eval:0" })');
		expect(error.message).not.toContain("already managed");

		await manager.stop("eval:0");
		await manager.flushNotifications();
	});
});
