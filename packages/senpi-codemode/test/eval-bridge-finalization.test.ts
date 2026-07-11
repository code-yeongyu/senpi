import type { AgentToolResult } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostToKernelMessage, KernelToHostMessage } from "../src/bridge/protocol.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { EvalKernel, EvalKernelManager, EvalKernelRunInput, ExecuteTool } from "../src/tool/types.ts";
import { Deferred, fakeExtensionContext } from "./eval/fakes.ts";

type EvalResult = Extract<KernelToHostMessage, { type: "result" }>;

class BridgeKernel implements EvalKernel {
	readonly replies: HostToKernelMessage[] = [];
	readonly interrupts: Array<string | undefined> = [];
	onMessage: ((message: KernelToHostMessage) => void) | undefined;
	readonly #result: EvalResult | undefined;
	readonly #throwOnReply: boolean;

	constructor(result: EvalResult | undefined, throwOnReply = false) {
		this.#result = result;
		this.#throwOnReply = throwOnReply;
	}

	async run(_input: EvalKernelRunInput): Promise<EvalResult> {
		this.onMessage?.({ type: "tool-call", callId: "bridge-call", toolName: "demo", args: {} });
		if (this.#result) return this.#result;
		return await new Promise<EvalResult>(() => {});
	}

	async interrupt(reason?: string): Promise<void> {
		this.interrupts.push(reason);
	}

	deliverToolReply(message: Extract<HostToKernelMessage, { type: "tool-reply" }>): void {
		if (this.#throwOnReply) throw new Error("bridge reply write failed");
		this.replies.push(message);
	}

	async reset(): Promise<void> {}

	async close(): Promise<void> {}
}

class BridgeManager implements EvalKernelManager {
	readonly #kernel: BridgeKernel;

	constructor(kernel: BridgeKernel) {
		this.#kernel = kernel;
	}

	async getKernel(_language: "js", onMessage: (message: KernelToHostMessage) => void): Promise<EvalKernel> {
		this.#kernel.onMessage = onMessage;
		return this.#kernel;
	}
}

function createTool(kernel: BridgeKernel, executeTool: ExecuteTool) {
	return createEvalTool({
		enabledLanguages: { js: true, py: false, rb: false, jl: false },
		kernelManager: new BridgeManager(kernel),
		cellTimeoutSeconds: 30,
		executeTool,
	});
}

describe("eval bridge finalization", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not wait for a hanging bridge call after the kernel returns a timeout result", async () => {
		const bridgeStarted = new Deferred<void>();
		const kernel = new BridgeKernel({
			type: "result",
			cellId: "bridge-timeout",
			ok: false,
			error: { message: "JS cell timed out after 5ms" },
			durationMs: 5,
		});
		const executeTool: ExecuteTool = vi.fn(async () => {
			bridgeStarted.resolve(undefined);
			return await new Promise<AgentToolResult<unknown>>(() => {});
		});
		const execution = createTool(kernel, executeTool).execute(
			"bridge-timeout",
			{ language: "js", code: "await tool.demo({})" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);
		await bridgeStarted.promise;

		await expect(execution).resolves.toMatchObject({ details: { isError: true } });
	});

	it("turns a bridge-handler rejection into the eval rejection without an unhandled promise", async () => {
		const kernel = new BridgeKernel(undefined, true);
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const execution = createTool(
				kernel,
				vi.fn(async () => ({ content: [], details: {} })),
			).execute(
				"bridge-rejection",
				{ language: "js", code: "await tool.demo({})" },
				undefined,
				undefined,
				fakeExtensionContext(),
			);

			await expect(execution).rejects.toThrow("bridge reply write failed");
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("keeps the deadline active through successful bridge finalization and ignores late replies", async () => {
		vi.useFakeTimers();
		const bridgeStarted = new Deferred<void>();
		const bridgeResult = new Deferred<AgentToolResult<unknown>>();
		const kernel = new BridgeKernel({
			type: "result",
			cellId: "bridge-success-timeout",
			ok: true,
			valueRepr: "kernel completed",
			durationMs: 5,
		});
		const executeTool: ExecuteTool = vi.fn(async () => {
			bridgeStarted.resolve(undefined);
			return await bridgeResult.promise;
		});
		const execution = createTool(kernel, executeTool).execute(
			"bridge-success-timeout",
			{ language: "js", code: "await tool.demo({})", timeout: 1 },
			undefined,
			undefined,
			fakeExtensionContext(),
		);
		const outcome = execution.then(
			(value) => ({ status: "fulfilled" as const, value }),
			(reason: unknown) => ({ status: "rejected" as const, reason }),
		);
		await bridgeStarted.promise;

		await vi.advanceTimersByTimeAsync(1_000);

		await expect(outcome).resolves.toMatchObject({
			status: "rejected",
			reason: { name: "TimeoutError", message: "Cell timed out after 1000ms" },
		});
		expect(kernel.interrupts).toEqual(["Cell timed out after 1000ms"]);
		bridgeResult.resolve({ content: [{ type: "text", text: "late bridge value" }], details: {} });
		await Promise.resolve();
		expect(kernel.replies).toEqual([]);
		kernel.onMessage?.({ type: "tool-call", callId: "late-call", toolName: "demo", args: {} });
		await Promise.resolve();
		expect(executeTool).toHaveBeenCalledTimes(1);
		expect(kernel.replies).toEqual([]);
	});
});
