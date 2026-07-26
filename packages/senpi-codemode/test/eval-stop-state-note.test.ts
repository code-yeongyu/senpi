import type { AgentToolResult } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvalDetachedCellManager } from "../src/tool/detached-cell-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { FakeKernel, FakeManager, fakeExtensionContext } from "./eval/fakes.ts";

type TextContent = Extract<AgentToolResult<unknown>["content"][number], { type: "text" }>;

afterEach(() => {
	vi.useRealTimers();
});

function textOf(result: AgentToolResult<unknown>): string {
	const texts: string[] = [];
	for (const part of result.content as readonly TextContent[]) {
		if (part.type === "text") texts.push(part.text);
	}
	return texts.join("\n");
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

async function detachPyCell(
	tool: ReturnType<typeof createTool>,
	kernel: FakeKernel,
	cellId: string,
): Promise<AgentToolResult<unknown>> {
	const started = kernel.deferNextRun();
	const execution = tool.execute(
		cellId,
		{ language: "py", code: "await forever", on_timeout: "detach" },
		undefined,
		undefined,
		{ ...fakeExtensionContext(), mode: "tui" as const },
	);
	await started;
	await vi.advanceTimersByTimeAsync(1_000);
	return await execution;
}

describe("eval stop reports true kernel state", () => {
	it("says Python state survived when the runner answered the stop interrupt", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager();
		const kernel = new FakeKernel([]);
		kernel.stateRetainedOnInterrupt = true;
		const tool = createTool(manager, [["py", kernel]]);

		await detachPyCell(tool, kernel, "stop-cooperative-cell");
		const stopped = await tool.execute(
			"stop-call-1",
			{ action: "stop", cell_id: "stop-cooperative-cell" },
			undefined,
			undefined,
			{ ...fakeExtensionContext(), mode: "tui" as const },
		);

		expect(textOf(stopped)).toContain("preserved");
	});

	it("says Python state was lost when the kernel had to be killed, never claiming preserved", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager();
		const kernel = new FakeKernel([]);
		kernel.stateRetainedOnInterrupt = false;
		const tool = createTool(manager, [["py", kernel]]);

		await detachPyCell(tool, kernel, "stop-killed-cell");
		const stopped = await tool.execute(
			"stop-call-2",
			{ action: "stop", cell_id: "stop-killed-cell" },
			undefined,
			undefined,
			{ ...fakeExtensionContext(), mode: "tui" as const },
		);

		const text = textOf(stopped);
		expect(text).not.toContain("preserved");
		expect(text).toMatch(/lost|gone|restart|recreated/i);
	});

	it("says JavaScript state was lost when the worker is restarted by stop", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager();
		const kernel = new FakeKernel([]);
		kernel.stateRetainedOnInterrupt = false;
		const tool = createTool(manager, [["js", kernel]]);
		const started = kernel.deferNextRun();
		const execution = tool.execute(
			"stop-js-cell",
			{ language: "js", code: "await forever", on_timeout: "detach" },
			undefined,
			undefined,
			{ ...fakeExtensionContext(), mode: "tui" as const },
		);
		await started;
		await vi.advanceTimersByTimeAsync(1_000);
		await execution;

		const stopped = await tool.execute(
			"stop-call-3",
			{ action: "stop", cell_id: "stop-js-cell" },
			undefined,
			undefined,
			{ ...fakeExtensionContext(), mode: "tui" as const },
		);

		const text = textOf(stopped);
		expect(text).not.toContain("preserved");
		expect(text).toMatch(/lost|restarted/i);
	});
});
