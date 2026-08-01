import type { AgentToolResult } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvalDetachedCellManager } from "../src/tool/detached-cell-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { EvalToolDetails } from "../src/tool/types.ts";
import {
	Deferred,
	FakeKernel,
	fakeExtensionContext,
	PendingInterruptKernel,
	result,
	SingleKernelManager,
} from "./eval/fakes.ts";

afterEach(() => {
	vi.useRealTimers();
});

function interactiveContext() {
	return { ...fakeExtensionContext(), mode: "tui" as const };
}

function textOf(resultValue: AgentToolResult<unknown>): string {
	return resultValue.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function requireCell(resultValue: AgentToolResult<EvalToolDetails>) {
	const cell = resultValue.details.cells?.[0];
	if (cell === undefined) throw new Error("expected one eval cell");
	return cell;
}

describe("detached eval settlement", () => {
	it("stops reading the live provider after terminal settlement", () => {
		const manager = new EvalDetachedCellManager();
		const input = { language: "js" as const, code: "42", title: "provider" };
		const cell = manager.create("provider-cell", input);
		const provider = vi.fn(
			(): AgentToolResult<EvalToolDetails> => ({
				content: [{ type: "text", text: "live" }],
				details: {
					language: "js",
					languages: ["js"],
					title: "provider",
					durationMs: 0,
					toolCalls: [],
					truncated: false,
					cells: [{ index: 0, ...input, output: "live", status: "running" }],
				},
			}),
		);
		manager.markRunning(cell, new FakeKernel([]), provider);
		manager.detach(cell);
		manager.peek("provider-cell");
		expect(provider).toHaveBeenCalledOnce();
		expect(manager.complete(cell, provider())).toBe(true);
		provider.mockClear();

		expect(manager.peek("provider-cell").result.details.cells?.[0]?.output).toBe("live");
		expect(provider).not.toHaveBeenCalled();
	});

	it("keeps cancellation authoritative over a late completion", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager();
		const kernel = new PendingInterruptKernel();
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: new SingleKernelManager(kernel),
			cellTimeoutSeconds: 1,
			executeTool: async () => ({
				content: [{ type: "text", text: "unused" }],
				details: {},
			}),
			cellManager: manager,
		});
		const lateCompletion = new Deferred<void>();
		const execution = tool.execute(
			"cancelled-cell",
			{ language: "js", code: "await forever", on_timeout: "detach" },
			undefined,
			(update) => {
				if (update.details.cells?.[0]?.status === "complete") lateCompletion.resolve(undefined);
			},
			interactiveContext(),
		);
		await kernel.runStarted.promise;
		await vi.advanceTimersByTimeAsync(1_000);
		await execution;
		const stopping = tool.execute(
			"stop-cancelled",
			{ action: "stop", cell_id: "cancelled-cell" },
			undefined,
			undefined,
			interactiveContext(),
		);
		await kernel.interruptStarted.promise;
		kernel.runResult.resolve(result("cancelled-cell", "late value", 77));
		await lateCompletion.promise;
		kernel.interruptResult.resolve(undefined);
		const stopped = await stopping;

		expect(textOf(stopped)).not.toContain("late value");
		expect(requireCell(stopped).status).toBe("cancelled");
		expect(manager.peek("cancelled-cell").state).toBe("cancelled");
	});
});
