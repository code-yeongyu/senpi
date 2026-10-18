import type { EvalHandleHost, ExtensionToolContext } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeEvalHandleHost } from "../../coding-agent/test/suite/fakes/eval-handle-host.ts";
import { RESERVED_HANDLE_STATUS_TOOL, RESERVED_WAIT_TOOL } from "../src/bridge/reserved.ts";
import { HandleRegistry } from "../src/handles/handle-registry.ts";
import { EvalDetachedCellManager } from "../src/tool/detached-cell-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { errorResult, FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";

const OWNER = "session-owner";

type Reply = {
	readonly callId: string;
	readonly ok: boolean;
	readonly value?: unknown;
	readonly error?: { code?: string };
};

function fixture(options: { host?: boolean; hardLimitSeconds?: number } = {}) {
	const host = new FakeEvalHandleHost({ ownerSessionId: OWNER });
	const registry = new HandleRegistry({ ownerSessionId: OWNER });
	const manager = new EvalDetachedCellManager({
		runBudgetSeconds: 2,
		hardLimitSeconds: options.hardLimitSeconds ?? 100,
	});
	const kernel = new FakeKernel([]);
	const tool = createEvalTool({
		enabledLanguages: { js: true, py: false, rb: false, jl: false },
		kernelManager: new FakeManager([["js", kernel]]),
		cellTimeoutSeconds: 1,
		executeTool: host.executeTool,
		cellManager: manager,
		handles: registry,
	});
	const ctx = (mode: "print" | "tui" = "print"): ExtensionToolContext & { evalHandleHost?: EvalHandleHost } => ({
		...fakeExtensionContext(),
		mode,
		...(options.host === false ? {} : { evalHandleHost: host }),
	});
	const replies = (): Reply[] =>
		kernel.replies.filter((reply): reply is Reply => typeof reply === "object" && reply !== null);
	return { host, registry, manager, kernel, tool, ctx, replies };
}

function input(code = "await wait([a, b])") {
	return { language: "js" as const, code, summary: "wait on handles" };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("wait() through a cell", () => {
	it("wait-preserves-order-and-pauses-budget: parked time consumes no run budget and values come back in input order", async () => {
		vi.useFakeTimers();
		const { host, kernel, tool, ctx, replies } = fixture();
		const a = host.spawn("agent");
		const b = host.spawn("agent");
		const started = kernel.deferNextRun();
		const execution = tool.execute("ordered", input(), undefined, undefined, ctx());
		await started;
		kernel.emit({ type: "status", event: { op: "timeout-pause" } });
		kernel.emit({ type: "tool-call", callId: "w1", toolName: RESERVED_WAIT_TOOL, args: { refs: [a, b] } });
		await vi.advanceTimersByTimeAsync(30_000);
		expect(kernel.interrupts).toEqual([]);
		host.settle(b.id, "B");
		host.settle(a.id, "A");
		await vi.advanceTimersByTimeAsync(0);
		expect(replies()).toEqual([{ type: "tool-reply", callId: "w1", ok: true, value: ["A", "B"] }]);
		kernel.emit({ type: "status", event: { op: "timeout-resume" } });
		await vi.advanceTimersByTimeAsync(1_999);
		expect(kernel.interrupts).toEqual([]);
		kernel.completeDeferredRun(result("ordered", '["A","B"]'));
		const settled = await execution;
		expect(JSON.stringify(settled.content)).toContain("A");
		expect(host.openWatches).toBe(0);
	});

	it("wait-detaches-past-foreground: a long barrier detaches like any bridge-parked cell and still settles", async () => {
		vi.useFakeTimers();
		const { host, kernel, tool, ctx, manager, replies } = fixture({ hardLimitSeconds: 1_000 });
		const a = host.spawn("agent");
		const started = kernel.deferNextRun();
		const execution = tool.execute(
			"barrier",
			{ ...input("await wait([a])"), on_timeout: "detach" },
			undefined,
			undefined,
			ctx("tui"),
		);
		await started;
		kernel.emit({ type: "status", event: { op: "timeout-pause" } });
		kernel.emit({ type: "tool-call", callId: "w1", toolName: RESERVED_WAIT_TOOL, args: { refs: [a] } });
		await vi.advanceTimersByTimeAsync(600_000);
		const detached = await execution;
		expect(JSON.stringify(detached.content)).toContain("barrier");
		expect(manager.peek("barrier").state).toBe("detached");
		expect(host.openWatches).toBe(1);
		host.settle(a.id, "late");
		await vi.advanceTimersByTimeAsync(0);
		expect(replies()).toEqual([{ type: "tool-reply", callId: "w1", ok: true, value: ["late"] }]);
		kernel.emit({ type: "status", event: { op: "timeout-resume" } });
		kernel.completeDeferredRun(result("barrier", '["late"]'));
		await manager.waitForTerminal("barrier");
		expect(manager.peek("barrier").state).toBe("completed");
		expect(host.openWatches).toBe(0);
	});

	it("a wait in flight in a kernel that dies ends with its cell and its subscription is closed", async () => {
		const { host, kernel, tool, ctx } = fixture();
		const a = host.spawn("agent");
		const started = kernel.deferNextRun();
		const execution = tool.execute("dying", input("await wait([a])"), undefined, undefined, ctx());
		await started;
		kernel.emit({ type: "status", event: { op: "timeout-pause" } });
		kernel.emit({ type: "tool-call", callId: "w1", toolName: RESERVED_WAIT_TOOL, args: { refs: [a] } });
		await vi.waitFor(() => expect(host.openWatches).toBe(1));
		kernel.completeDeferredRun(errorResult("dying", "JavaScript kernel worker exited"));
		const settled = await execution;
		expect(JSON.stringify(settled.content)).toContain("worker exited");
		expect(host.openWatches).toBe(0);
		expect(host.epochState(a.id, 0)).toMatchObject({ phase: "pending", cancelCalls: [] });
	});

	it("unavailable runtime: without ctx.evalHandleHost an agent ref fails with eval_wait_unavailable and no task_output call", async () => {
		const { host, kernel, tool, ctx, replies } = fixture({ host: false });
		const a = host.spawn("agent");
		const started = kernel.deferNextRun();
		const execution = tool.execute("no-host", input("await wait([a])"), undefined, undefined, ctx());
		await started;
		kernel.emit({ type: "tool-call", callId: "w1", toolName: RESERVED_WAIT_TOOL, args: { refs: [a] } });
		kernel.emit({ type: "tool-call", callId: "s1", toolName: RESERVED_HANDLE_STATUS_TOOL, args: { ref: a } });
		await vi.waitFor(() => expect(replies()).toHaveLength(2));
		expect(replies().map((reply) => reply.error?.code)).toEqual(["eval_wait_unavailable", "eval_wait_unavailable"]);
		expect(JSON.stringify(replies())).toContain("not supported by this runtime");
		expect(host.toolCallCount("task_output")).toBe(0);
		kernel.completeDeferredRun(result("no-host", "null"));
		await execution;
	});

	it("rebinds a saved ref after a kernel reset while the owner and run epoch are valid", async () => {
		const { host, kernel, tool, ctx, replies } = fixture();
		const a = host.spawn("agent");
		await tool.execute("first", input("const a = handle(ref)"), undefined, undefined, ctx()).catch(() => undefined);
		kernel.replaceMessages([result("reset", "ok")]);
		const started = kernel.deferNextRun();
		const execution = tool.execute(
			"reset",
			{ ...input("handle(saved).control.status()"), reset: true },
			undefined,
			undefined,
			ctx(),
		);
		await started;
		expect(kernel.resetCount).toBe(1);
		kernel.emit({ type: "tool-call", callId: "s1", toolName: RESERVED_HANDLE_STATUS_TOOL, args: { ref: a } });
		await vi.waitFor(() => expect(replies()).toHaveLength(1));
		expect(replies()[0]).toMatchObject({ ok: true, value: { ref: a, phase: "pending" } });
		kernel.completeDeferredRun(result("reset", "ok"));
		await execution;
	});
});
