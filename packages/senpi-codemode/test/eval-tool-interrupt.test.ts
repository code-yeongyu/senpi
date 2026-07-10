import type { AgentToolResult } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { createEvalTool, type EvalKernel, type EvalKernelManager } from "../src/tool/eval-tool.ts";
import type { ExecuteTool } from "../src/tool/types.ts";
import { Deferred, FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";

type ToolResult = AgentToolResult<unknown>;
type ToolContent = ToolResult["content"][number];
type TextPart = Extract<ToolContent, { type: "text" }>;
type EvalResult = Extract<KernelToHostMessage, { type: "result" }>;

class DelayedKernelManager implements EvalKernelManager {
	readonly requested = new Deferred<void>();
	readonly acquired = new Deferred<EvalKernel>();

	async getKernel(): Promise<EvalKernel> {
		this.requested.resolve(undefined);
		return await this.acquired.promise;
	}
}

class DelayedResetKernel extends FakeKernel {
	readonly resetStarted = new Deferred<void>();
	readonly resetReleased = new Deferred<void>();

	override async reset(): Promise<void> {
		this.resetStarted.resolve(undefined);
		await this.resetReleased.promise;
	}
}

class PendingInterruptKernel implements EvalKernel {
	readonly runStarted = new Deferred<void>();
	readonly runResult = new Deferred<EvalResult>();
	readonly interruptResult = new Deferred<void>();
	readonly interrupts: Array<string | undefined> = [];

	async run(): Promise<EvalResult> {
		this.runStarted.resolve(undefined);
		return await this.runResult.promise;
	}

	async interrupt(reason?: string): Promise<void> {
		this.interrupts.push(reason);
		await this.interruptResult.promise;
	}

	deliverToolReply(): void {}

	async reset(): Promise<void> {}

	async close(): Promise<void> {}
}

class SingleKernelManager implements EvalKernelManager {
	readonly kernel: EvalKernel;

	constructor(kernel: EvalKernel) {
		this.kernel = kernel;
	}

	async getKernel(): Promise<EvalKernel> {
		return this.kernel;
	}
}

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

describe("createEvalTool interrupt handling", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("preempts kernel acquisition when the outer signal aborts", async () => {
		const controller = new AbortController();
		const manager = new DelayedKernelManager();
		const kernel = new FakeKernel([result("cell-acquire-abort", "must not run")]);
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: manager,
			cellTimeoutSeconds: 30,
			executeTool: vi.fn(),
		});
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
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: new FakeManager([["js", kernel]]),
			cellTimeoutSeconds: 30,
			executeTool: vi.fn(),
		});
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
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: new FakeManager([["js", kernel]]),
			cellTimeoutSeconds: 30,
			executeTool,
		});
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
		const controller = new AbortController();
		const kernel = new PendingInterruptKernel();
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: new SingleKernelManager(kernel),
			cellTimeoutSeconds: 30,
			executeTool: vi.fn(),
		});
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

		await expect(execution).rejects.toThrow("stop pending cell");
		expect(settlementCount).toBe(1);
		kernel.interruptResult.reject(new Error("interrupt rejected asynchronously"));
		kernel.runResult.resolve(result("cell-interrupt-rejection", "late"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settlementCount).toBe(1);
		expect(kernel.interrupts).toEqual(["stop pending cell"]);
	});

	it("does not interrupt a completed kernel when a stale signal aborts", async () => {
		const controller = new AbortController();
		const kernel = new FakeKernel([result("cell-late-abort", "ok")]);
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: new FakeManager([["js", kernel]]),
			cellTimeoutSeconds: 30,
			executeTool: vi.fn(),
		});
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
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: manager,
			cellTimeoutSeconds: 30,
			executeTool: vi.fn(),
		});

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
