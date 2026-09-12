import type { AgentToolResult, ExtensionContext } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { EvalDetachedCellManager } from "../src/tool/detached-cell-manager.ts";
import { EVAL_EXECUTION_EVENT, type EvalExecutionEventPayload } from "../src/tool/eval-execution-event.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { ExecuteTool } from "../src/tool/types.ts";
import { Deferred, errorResult, FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

type SerialResultMessage = Extract<KernelToHostMessage, { type: "result" }>;

class SerialFakeKernel extends FakeKernel {
	readonly #serialMessages: KernelToHostMessage[];
	constructor(messages: KernelToHostMessage[]) {
		super(messages);
		this.#serialMessages = messages;
	}
	/** Emits tool-calls one at a time, waiting for each host reply — deterministic per-call wall-clock durations. */
	async run(input: { cellId: string; code: string; timeoutMs?: number }): Promise<SerialResultMessage> {
		this.runs.push(input);
		for (const message of this.#serialMessages) {
			if (message.type !== "tool-call") continue;
			const repliesBefore = this.replies.length;
			this.onMessage?.(message);
			while (this.replies.length === repliesBefore) await Promise.resolve();
		}
		const settled = this.#serialMessages.find((message): message is SerialResultMessage => message.type === "result");
		if (!settled) throw new Error("fake kernel missing result");
		return settled;
	}
}

function textResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: {} };
}

function createTool(
	kernel: FakeKernel,
	executeTool: ExecuteTool = vi.fn(async () => textResult("ok")),
	onCellSettled?: (payload: EvalExecutionEventPayload) => void,
	cellManager?: EvalDetachedCellManager,
) {
	return createEvalTool({
		enabledLanguages: { js: true, py: false, rb: false, jl: false },
		kernelManager: new FakeManager([["js", kernel]]),
		cellTimeoutSeconds: 1,
		executeTool,
		...(onCellSettled === undefined ? {} : { onCellSettled }),
		...(cellManager === undefined ? {} : { cellManager }),
	});
}

function interactiveContext(): ExtensionContext {
	return { ...fakeExtensionContext(), mode: "tui" };
}

describe("eval execution event contract", () => {
	it("pins the exact event literal", () => {
		expect(EVAL_EXECUTION_EVENT).toBe("senpi.eval.execution");
	});

	it("builds the full successful payload and exact aggregates from nested tool calls", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		const kernel = new SerialFakeKernel([
			{ type: "tool-call", callId: "read-1", toolName: "read", args: { path: "/tmp/a" } },
			{ type: "tool-call", callId: "bash-1", toolName: "bash", args: { command: "true" } },
			result("successful-cell", "done", 99),
		]);
		const executeTool: ExecuteTool = vi.fn(async (name) => {
			vi.setSystemTime(Date.now() + (name === "read" ? 11 : 7));
			return textResult(`${name} result`);
		});
		const emissions: EvalExecutionEventPayload[] = [];

		await createTool(kernel, executeTool, (payload) => emissions.push(payload)).execute(
			"successful-cell",
			{ language: "js", code: "await Promise.all([tool.read({}), tool.bash({})])", summary: "two calls" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		expect(emissions).toHaveLength(1);
		expect(emissions[0]).toEqual({
			version: 1,
			detailLevel: "full",
			cellId: "successful-cell",
			language: "js",
			ok: true,
			startedAt: 1_000,
			completedAt: 1_018,
			durationMs: 18,
			kernelDurationMs: 99,
			detached: false,
			toolCallCount: 2,
			pendingToolCallCount: 0,
			toolCalls: [
				{
					name: "read",
					ok: true,
					callId: "read-1",
					args: { path: "/tmp/a" },
					durationMs: 11,
					resultPreview: "read result",
				},
				{
					name: "bash",
					ok: true,
					callId: "bash-1",
					args: { command: "true" },
					durationMs: 7,
					resultPreview: "bash result",
				},
			],
			distinctToolsCalled: ["read", "bash"],
			toolAggregates: {
				read: { count: 1, totalDurationMs: 11, okCount: 1, errorCount: 0, pendingCount: 0 },
				bash: { count: 1, totalDurationMs: 7, okCount: 1, errorCount: 0, pendingCount: 0 },
			},
			toolAggregatesTruncated: false,
		});
	});

	it("emits one bounded error payload when the cell settles with an error", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(2_000);
		const longError = "x".repeat(600);
		const emissions: EvalExecutionEventPayload[] = [];

		await createTool(new FakeKernel([errorResult("error-cell", longError)]), undefined, (payload) =>
			emissions.push(payload),
		).execute(
			"error-cell",
			{ language: "js", code: "throw new Error()", summary: "error" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		expect(emissions).toHaveLength(1);
		expect(emissions[0]).toMatchObject({
			version: 1,
			detailLevel: "full",
			cellId: "error-cell",
			language: "js",
			ok: false,
			startedAt: 2_000,
			completedAt: 2_000,
			durationMs: 0,
			kernelDurationMs: 5,
			detached: false,
			toolCallCount: 0,
			pendingToolCallCount: 0,
			toolCalls: [],
			distinctToolsCalled: [],
			toolAggregates: {},
		});
		expect(emissions[0]?.error).toBe(`${"x".repeat(512)}…`);
	});

	it("is a no-op when onCellSettled is absent", async () => {
		const settledNoCallback = await createTool(new FakeKernel([result("callbackless-cell", "ok")])).execute(
			"callbackless-cell",
			{ language: "js", code: "1", summary: "no callback" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);
		expect(settledNoCallback.details.isError).toBeUndefined();
	});

	it("keeps all forty calls in counts and aggregates while capping enriched payload calls at thirty", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(3_000);
		const messages: KernelToHostMessage[] = [];
		for (let index = 0; index < 40; index += 1) {
			messages.push({
				type: "tool-call",
				callId: `call-${index}`,
				toolName: index % 2 === 0 ? "read" : "bash",
				args: { index, text: "z".repeat(600) },
			});
		}
		messages.push(result("forty-cell", "done", 80));
		const executeTool: ExecuteTool = vi.fn(async () => {
			vi.setSystemTime(Date.now() + 2);
			return textResult("ok");
		});
		const emissions: EvalExecutionEventPayload[] = [];

		await createTool(new SerialFakeKernel(messages), executeTool, (payload) => emissions.push(payload)).execute(
			"forty-cell",
			{ language: "js", code: "many calls", summary: "forty calls" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		const payload = emissions[0];
		expect(payload).toBeDefined();
		expect(payload?.toolCallCount).toBe(40);
		expect(payload?.distinctToolsCalled).toEqual(["read", "bash"]);
		expect(payload?.toolCalls).toHaveLength(30);
		expect(payload?.toolCalls.every((call) => call.args !== undefined && call.argsTruncated === true)).toBe(true);
		expect(payload?.toolCalls.every((call) => call.durationMs === 2)).toBe(true);
		expect(payload?.toolAggregates).toEqual({
			read: { count: 20, totalDurationMs: 40, okCount: 20, errorCount: 0, pendingCount: 0 },
			bash: { count: 20, totalDurationMs: 40, okCount: 20, errorCount: 0, pendingCount: 0 },
		});
		expect(Object.values(payload?.toolAggregates ?? {}).reduce((sum, item) => sum + item.totalDurationMs, 0)).toBe(
			80,
		);
	});

	it("derives wall duration and exact nested tool-call count in returned details separately from kernel duration", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		const kernel = new SerialFakeKernel([
			{ type: "tool-call", callId: "read-1", toolName: "read", args: { path: "/tmp/a" } },
			{ type: "tool-call", callId: "bash-1", toolName: "bash", args: { command: "true" } },
			result("throughput-cell", "done", 99),
		]);
		const executeTool: ExecuteTool = vi.fn(async (name) => {
			vi.setSystemTime(Date.now() + (name === "read" ? 11 : 7));
			return textResult(`${name} result`);
		});

		const settled = await createTool(kernel, executeTool).execute(
			"throughput-cell",
			{ language: "js", code: "await Promise.all([tool.read({}), tool.bash({})])", summary: "two calls" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		expect(settled.details.toolCallCount).toBe(2);
		expect(settled.details.wallDurationMs).toBe(18);
		expect(settled.details.durationMs).toBe(99);
		expect(settled.details.cells?.[0]?.durationMs).toBe(99);
	});

	it("emits exactly once after a detached cell reaches terminal settlement", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(4_000);
		const kernel = new FakeKernel([]);
		const manager = new EvalDetachedCellManager();
		const emissions: EvalExecutionEventPayload[] = [];
		const settled = new Deferred<EvalExecutionEventPayload>();
		const tool = createTool(
			kernel,
			undefined,
			(payload) => {
				emissions.push(payload);
				settled.resolve(payload);
			},
			manager,
		);
		const started = kernel.deferNextRun();
		const execution = tool.execute(
			"detached-cell",
			{ language: "js", code: "await forever", summary: "detach", on_timeout: "detach" },
			undefined,
			undefined,
			interactiveContext(),
		);
		await started;
		await vi.advanceTimersByTimeAsync(1_000);
		await execution;
		expect(emissions).toEqual([]);

		kernel.completeDeferredRun(result("detached-cell", "done", 73));
		const payload = await settled.promise;

		expect(payload).toMatchObject({
			cellId: "detached-cell",
			ok: true,
			detached: true,
			durationMs: 1_000,
			kernelDurationMs: 73,
		});
		expect(emissions).toHaveLength(1);
		await manager.flushNotifications();
	});
});
