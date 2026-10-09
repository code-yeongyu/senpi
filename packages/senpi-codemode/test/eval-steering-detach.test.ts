import { afterEach, describe, expect, it, vi } from "vitest";
import { CellExecution } from "../src/tool/cell-execution.ts";
import { EvalDetachedCellManager } from "../src/tool/detached-cell-manager.ts";
import type { EvalExecutionEventPayload } from "../src/tool/eval-execution-event.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { EvalToolInput } from "../src/tool/types.ts";
import { DelayedKernelManager, FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";

const input: EvalToolInput = { language: "js", code: "await gated", summary: "steering regression" };
function fixture() {
	const steering = new AbortController();
	const caller = new AbortController();
	const kernel = new FakeKernel([]);
	const started = kernel.deferNextRun();
	const manager = new EvalDetachedCellManager({ maxDetachedCells: 1 });
	const settled = vi.fn<(payload: EvalExecutionEventPayload) => void>();
	const tool = createEvalTool({
		enabledLanguages: { js: true, py: true, rb: false, jl: false },
		kernelManager: new FakeManager([
			["js", kernel],
			["py", new FakeKernel([result("other", "42")])],
		]),
		cellTimeoutSeconds: 30,
		cellManager: manager,
		onCellSettled: settled,
		executeTool: async () => ({ content: [], details: {} }),
	});
	const context = { ...fakeExtensionContext(), mode: "tui" as const, steeringSignal: steering.signal };
	return { steering, caller, kernel, started, manager, settled, tool, context };
}

afterEach(() => vi.restoreAllMocks());

// Regression coverage for #1637; every gated run is released even when the RED assertion fails.
describe("foreground eval steering", () => {
	it("detaches immediately on steering without cancelling or releasing its language slot", async () => {
		const f = fixture();
		const cancel = vi.spyOn(CellExecution.prototype, "cancel");
		const execution = f.tool.execute("cell", input, f.caller.signal, undefined, f.context);
		await f.started;
		try {
			f.steering.abort();
			expect(f.manager.peek("cell").state).toBe("detached");
			const detached = await execution;
			expect(detached.details.cells?.[0]?.status).toBe("detached");
			expect(f.settled).not.toHaveBeenCalled();
			expect(cancel).not.toHaveBeenCalled();
			expect(f.kernel.interrupts).toEqual([]);
			expect(f.manager.liveCells("js")).toMatchObject([{ cellId: "cell", state: "detached" }]);
			const other = await f.tool.execute("other", { ...input, language: "py" }, undefined, undefined, f.context);
			expect(other.details.isError).not.toBe(true);
		} finally {
			f.kernel.completeDeferredRun(result("cell", "42"));
			await execution;
			await f.manager.waitForTerminal("cell");
			await f.manager.dispose();
		}
		expect(f.settled.mock.calls.filter(([event]) => event.cellId === "cell")).toHaveLength(1);
		expect(f.manager.liveCells("js")).toEqual([]);
	});

	it("keeps waiting with zero cancel calls when the global detached cap is reached", async () => {
		const f = fixture();
		const owner = f.manager.create("owner", { ...input, language: "py" });
		f.manager.bindKernel(owner, new FakeKernel([]), () => ({
			content: [],
			details: { language: "py", durationMs: 0, toolCalls: [], truncated: false },
		}));
		f.manager.markRunning(owner);
		expect(f.manager.detach(owner)).toBe(true);
		const detach = vi.spyOn(f.manager, "detach");
		const cancel = vi.spyOn(CellExecution.prototype, "cancel");
		const execution = f.tool.execute("cell", input, undefined, undefined, f.context);
		await f.started;
		try {
			f.steering.abort();
			expect(detach).toHaveBeenCalledOnce();
			expect(f.manager.peek("cell").state).toBe("running");
			expect(cancel).not.toHaveBeenCalled();
			expect(f.kernel.interrupts).toEqual([]);
			expect(f.settled).not.toHaveBeenCalled();
		} finally {
			f.kernel.completeDeferredRun(result("cell", "42"));
			const completed = await execution;
			expect(completed.details.cells?.[0]?.status).toBe("complete");
			expect(completed.details.isError).not.toBe(true);
			expect(cancel).not.toHaveBeenCalled();
			await f.manager.dispose();
		}
		expect(f.settled).toHaveBeenCalledOnce();
	});

	it.each(["print", "json", "explicit-error", "missing-signal"] as const)(
		"preserves foreground behavior for %s",
		async (mode) => {
			const f = fixture();
			const context = mode === "print" || mode === "json" ? { ...f.context, mode } : f.context;
			const execution = f.tool.execute(
				"cell",
				mode === "explicit-error" ? { ...input, on_timeout: "error" } : input,
				undefined,
				undefined,
				mode === "missing-signal" ? { ...context, steeringSignal: undefined } : context,
			);
			await f.started;
			try {
				f.steering.abort();
				expect(f.manager.peek("cell").state).toBe("running");
				expect(f.kernel.interrupts).toEqual([]);
			} finally {
				f.kernel.completeDeferredRun(result("cell", "42"));
				await execution;
				await f.manager.dispose();
			}
		},
	);

	it.each(["steer-first", "abort-first"] as const)("retains single caller-abort ownership for %s", async (order) => {
		const f = fixture();
		const execution = f.tool.execute("cell", input, f.caller.signal, undefined, f.context).then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		);
		await f.started;
		if (order === "steer-first") f.steering.abort();
		f.caller.abort(new Error("caller-owned"));
		f.steering.abort();
		f.caller.abort(new Error("repeated"));
		await execution;
		await f.manager.waitForTerminal("cell");
		expect(f.kernel.interrupts).toEqual(["caller-owned"]);
		expect(f.manager.peek("cell").state).toBe("failed");
		expect(f.settled).toHaveBeenCalledOnce();
		await f.manager.dispose();
	});

	it("does not detach a completed invocation or retain its steering listener", async () => {
		const f = fixture();
		const remove = vi.spyOn(f.steering.signal, "removeEventListener");
		const execution = f.tool.execute("cell", input, undefined, undefined, f.context);
		await f.started;
		f.kernel.completeDeferredRun(result("cell", "42"));
		await execution;
		f.steering.abort();
		expect(f.manager.peek("cell").state).toBe("completed");
		expect(f.kernel.interrupts).toEqual([]);
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
		await f.manager.dispose();
	});

	it.each([true, false])("handles steering queued before kernel readiness (already queued: %s)", async (already) => {
		const f = fixture();
		const kernelManager = new DelayedKernelManager();
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager,
			cellTimeoutSeconds: 30,
			cellManager: f.manager,
			executeTool: async () => ({ content: [], details: {} }),
		});
		if (already) f.steering.abort();
		const execution = tool.execute("cell", input, undefined, undefined, f.context);
		await kernelManager.requested.promise;
		if (!already) f.steering.abort();
		kernelManager.acquired.resolve(f.kernel);
		await f.started;
		try {
			expect(f.manager.peek("cell").state).toBe("detached");
			expect((await execution).details.cells?.[0]?.status).toBe("detached");
		} finally {
			f.kernel.completeDeferredRun(result("cell", "42"));
			await execution;
			await f.manager.waitForTerminal("cell");
			await f.manager.dispose();
		}
	});

	it("enforces the global cap without replacing the existing detached owner", async () => {
		const manager = new EvalDetachedCellManager({ maxDetachedCells: 1 });
		const kernel = new FakeKernel([]);
		const first = manager.create("first", input);
		const second = manager.create("second", input);
		const live = () => ({
			content: [],
			details: { language: "js" as const, durationMs: 0, toolCalls: [], truncated: false },
		});
		manager.bindKernel(first, kernel, live);
		manager.markRunning(first);
		manager.bindKernel(second, kernel, live);
		manager.markRunning(second);
		try {
			expect(manager.detach(first)).toBe(true);
			expect(manager.detach(second)).toBe(false);
			expect(manager.liveCells("js")).toMatchObject([
				{ cellId: "first", state: "detached" },
				{ cellId: "second", state: "running" },
			]);
			expect(manager.peek("second").state).toBe("running");
		} finally {
			manager.complete(first, live());
			manager.complete(second, live());
			await manager.dispose();
		}
	});
});
