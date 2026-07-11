import type { AgentToolResult } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvalTool, type EvalKernelManager } from "../src/tool/eval-tool.ts";
import type { ExecuteTool } from "../src/tool/types.ts";
import {
	Deferred,
	DelayedKernelManager,
	DelayedResetKernel,
	FakeKernel,
	FakeManager,
	fakeExtensionContext,
	KernelOwnedTimeoutKernel,
	PendingInterruptKernel,
	result,
	SingleKernelManager,
} from "./eval/fakes.ts";

type ToolResult = AgentToolResult<unknown>;
type ToolContent = ToolResult["content"][number];
type TextPart = Extract<ToolContent, { type: "text" }>;

function textOf(toolResult: ToolResult): string {
	const texts: string[] = [];
	for (const part of toolResult.content) {
		if (isTextPart(part)) texts.push(part.text);
	}
	return texts.join("\n");
}

function isTextPart(part: ToolContent): part is TextPart {
	return part.type === "text";
}

function createTool(kernelManager: EvalKernelManager, cellTimeoutSeconds = 30, executeTool: ExecuteTool = vi.fn()) {
	return createEvalTool({
		enabledLanguages: { js: true, py: false, rb: false, jl: false },
		kernelManager,
		cellTimeoutSeconds,
		executeTool,
	});
}

describe("createEvalTool interrupt handling", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("preempts kernel acquisition when the outer signal aborts", async () => {
		const controller = new AbortController();
		const manager = new DelayedKernelManager();
		const kernel = new FakeKernel([result("cell-acquire-abort", "must not run")]);
		const tool = createTool(manager);
		const execution = tool.execute(
			"cell-acquire-abort",
			{ language: "js", code: "1" },
			controller.signal,
			undefined,
			fakeExtensionContext(),
		);
		await manager.requested.promise;

		controller.abort(new Error("abort during acquisition"));

		await expect(execution).rejects.toThrow("abort during acquisition");
		expect(kernel.runs).toEqual([]);
		manager.acquired.resolve(kernel);
	});

	it("preempts reset when the configured deadline expires", async () => {
		vi.useFakeTimers();
		const kernel = new DelayedResetKernel([result("cell-reset-timeout", "must not run")]);
		const tool = createTool(new FakeManager([["js", kernel]]));
		const execution = tool.execute(
			"cell-reset-timeout",
			{ language: "js", code: "1", reset: true, timeout: 1 },
			undefined,
			undefined,
			fakeExtensionContext(),
		);
		const outcome = execution.then(
			(value) => ({ status: "fulfilled" as const, value }),
			(reason: unknown) => ({ status: "rejected" as const, reason }),
		);
		await kernel.resetStarted.promise;

		await vi.advanceTimersByTimeAsync(1_000);

		await expect(outcome).resolves.toMatchObject({
			status: "rejected",
			reason: { name: "TimeoutError", message: "Cell timed out after 1000ms" },
		});
		expect(kernel.interrupts).toEqual(["Cell timed out after 1000ms"]);
		expect(kernel.runs).toEqual([]);
		kernel.resetReleased.resolve(undefined);
	});

	it("preserves the kernel timeout result when its deadline equals the cell timeout", async () => {
		vi.useFakeTimers();
		const kernel = new KernelOwnedTimeoutKernel();
		const tool = createTool(new SingleKernelManager(kernel));
		const execution = tool.execute(
			"cell-kernel-timeout",
			{ language: "js", code: "while (true) {}", timeout: 1 },
			undefined,
			undefined,
			fakeExtensionContext(),
		);
		const outcome = execution.then(
			(value) => ({ status: "fulfilled" as const, value }),
			(reason: unknown) => ({ status: "rejected" as const, reason }),
		);
		await kernel.runStarted.promise;

		await vi.advanceTimersByTimeAsync(1_000);

		const settled = await outcome;
		expect(settled).toMatchObject({ status: "fulfilled", value: { details: { durationMs: 1_000, isError: true } } });
		if (settled.status === "rejected") throw settled.reason;
		const toolResult = settled.value;
		expect(textOf(toolResult)).toContain("Kernel timed out after 1000ms");
		expect(kernel.interrupts).toEqual([]);
	});

	it("combines the caller and cell lifecycle signals for nested tools", async () => {
		const controller = new AbortController();
		const bridgeStarted = new Deferred<AbortSignal>();
		const kernel = new FakeKernel([
			{ type: "tool-call", callId: "call-abort", toolName: "slow", args: {} },
			result("cell-active-abort", "must not finalize"),
		]);
		const executeTool: ExecuteTool = vi.fn(async (_toolName, _params, options) => {
			const nestedSignal = options?.signal;
			if (!nestedSignal) throw new Error("missing nested bridge signal");
			bridgeStarted.resolve(nestedSignal);
			return await new Promise<ToolResult>((_resolve, reject) => {
				nestedSignal.addEventListener("abort", () => reject(nestedSignal.reason), { once: true });
			});
		});
		const tool = createTool(new FakeManager([["js", kernel]]), 30, executeTool);
		const execution = tool.execute(
			"cell-active-abort",
			{ language: "js", code: "await tool.slow({})" },
			controller.signal,
			undefined,
			fakeExtensionContext(),
		);
		const nestedSignal = await bridgeStarted.promise;

		controller.abort(new Error("stop nested tool"));

		await expect(execution).rejects.toThrow("stop nested tool");
		expect(nestedSignal).not.toBe(controller.signal);
		expect(nestedSignal.aborted).toBe(true);
		expect(kernel.interrupts).toEqual(["stop nested tool"]);
		expect(kernel.replies).toEqual([]);
	});

	it("settles once when interrupt remains pending and later rejects", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const kernel = new PendingInterruptKernel();
		const tool = createTool(new SingleKernelManager(kernel), 920);
		let settlementCount = 0;
		const outcome = tool
			.execute(
				"cell-pending-interrupt",
				{ language: "js", code: "await pending" },
				controller.signal,
				undefined,
				fakeExtensionContext(),
			)
			.then(
				(value) => {
					settlementCount++;
					return { status: "fulfilled" as const, value };
				},
				(reason: unknown) => {
					settlementCount++;
					return { status: "rejected" as const, reason };
				},
			);
		await kernel.runStarted.promise;

		controller.abort(new Error("stop pending cell"));
		await kernel.interruptStarted.promise;
		try {
			await vi.advanceTimersByTimeAsync(100);
			const settled = await Promise.race([outcome, Promise.resolve({ status: "pending" as const })]);
			expect(settled).toMatchObject({ status: "rejected", reason: { message: "stop pending cell" } });
			expect(settlementCount).toBe(1);
			kernel.interruptResult.reject(new Error("late interrupt rejection"));
			await vi.advanceTimersByTimeAsync(0);
			expect(settlementCount).toBe(1);
		} finally {
			kernel.interruptResult.resolve(undefined);
			kernel.runResult.resolve(result("cell-pending-interrupt", "late"));
			await outcome;
		}
		expect(kernel.interrupts).toEqual(["stop pending cell"]);
	});

	it("propagates an asynchronous interrupt rejection into eval settlement exactly once", async () => {
		const controller = new AbortController();
		const kernel = new PendingInterruptKernel();
		const tool = createTool(new SingleKernelManager(kernel));
		let settlementCount = 0;
		const execution = tool
			.execute(
				"cell-interrupt-rejection",
				{ language: "js", code: "await pending" },
				controller.signal,
				undefined,
				fakeExtensionContext(),
			)
			.finally(() => {
				settlementCount++;
			});
		await kernel.runStarted.promise;

		controller.abort(new Error("stop pending cell"));
		await kernel.interruptStarted.promise;
		kernel.interruptResult.reject(new Error("interrupt rejected asynchronously"));

		await expect(execution).rejects.toThrow("interrupt rejected asynchronously");
		expect(settlementCount).toBe(1);
		kernel.runResult.resolve(result("cell-interrupt-rejection", "late"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settlementCount).toBe(1);
		expect(kernel.interrupts).toEqual(["stop pending cell"]);
	});

	it("does not interrupt a completed kernel when a stale signal aborts", async () => {
		const controller = new AbortController();
		const kernel = new FakeKernel([result("cell-late-abort", "ok")]);
		const tool = createTool(new FakeManager([["js", kernel]]));
		const toolResult = await tool.execute(
			"cell-late-abort",
			{ language: "js", code: "1" },
			controller.signal,
			undefined,
			fakeExtensionContext(),
		);

		controller.abort(new Error("stale abort"));

		expect(textOf(toolResult)).toContain("ok");
		expect(kernel.interrupts).toEqual([]);
	});

	it("handles an already-aborted eval signal without starting a kernel run", async () => {
		const controller = new AbortController();
		controller.abort();
		const kernel = new FakeKernel([result("cell-pre-abort", "should not run")]);
		const manager = new FakeManager([["js", kernel]]);
		const getKernel = vi.spyOn(manager, "getKernel");
		const tool = createTool(manager);

		await expect(
			tool.execute(
				"cell-pre-abort",
				{ language: "js", code: "return 42" },
				controller.signal,
				undefined,
				fakeExtensionContext(),
			),
		).rejects.toThrow("Eval interrupted");
		expect(getKernel).not.toHaveBeenCalled();
		expect(kernel.runs).toHaveLength(0);
	});
});
