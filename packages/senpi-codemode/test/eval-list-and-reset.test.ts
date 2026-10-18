import { Check } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import { EvalDetachedCellManager, type EvalDetachedCellNotification } from "../src/tool/detached-cell-manager.ts";
import { EvalKernelResetRefusedError } from "../src/tool/eval-kernel-reset-refused-error.ts";
import { isEvalControlRequest, parseEvalRequest } from "../src/tool/eval-request.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { renderEvalCall, renderEvalResult } from "../src/tool/render.ts";
import { createEvalInputSchema, type EvalLanguage } from "../src/tool/types.ts";
import { FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";
import { QueuedFakeKernel } from "./eval/queued-fake.ts";
import { callContext, renderLines, resultContext } from "./eval-render-fixtures.ts";

const enabled = { js: true, py: true, rb: false, jl: false };
const managers: EvalDetachedCellManager[] = [];
afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.dispose();
	vi.useRealTimers();
});

function fixture() {
	vi.useFakeTimers();
	vi.setSystemTime(1000);
	const notices: EvalDetachedCellNotification[] = [];
	const manager = new EvalDetachedCellManager({ notifier: { notify: (batch) => notices.push(...batch) } });
	managers.push(manager);
	const js = new QueuedFakeKernel();
	const py = new QueuedFakeKernel();
	const tool = createEvalTool({
		enabledLanguages: enabled,
		kernelManager: new FakeManager([
			["js", js],
			["py", py],
		]),
		cellManager: manager,
		cellTimeoutSeconds: 30,
		executeTool: vi.fn(),
	});
	const context = { ...fakeExtensionContext(), mode: "tui" as const };
	async function submit(cellId: string, language: EvalLanguage = "js", reset = false) {
		const kernel = language === "js" ? js : py;
		const admitted = kernel.admitted(cellId);
		const steering = new AbortController();
		const execution = tool.execute(
			cellId,
			{ language, code: cellId, summary: `summary ${cellId}`, reset },
			undefined,
			undefined,
			{ ...context, steeringSignal: steering.signal },
		);
		await Promise.race([admitted, execution]);
		return { execution, steering };
	}
	function list() {
		return tool.execute("listing", { action: "list" }, undefined, undefined, context);
	}
	return { manager, js, py, tool, context, notices, submit, list };
}

// senpi#1908: list is observational; reset must not destroy another cell's kernel.
describe("eval list and busy-kernel reset refusal", () => {
	it("accepts list without run fields or cell_id while peek and stop require a cell_id", () => {
		const schema = createEvalInputSchema(enabled);
		expect(Check(schema, { action: "list" })).toBe(true);
		for (const action of ["peek", "stop"]) {
			expect(Check(schema, { action })).toBe(false);
			expect(Check(schema, { action, cell_id: "" })).toBe(false);
			expect(Check(schema, { action, cell_id: "A" })).toBe(true);
		}
	});

	it("parses list as control and leaves its arguments untouched", () => {
		const f = fixture();
		const request = parseEvalRequest({ action: "list" });
		expect(request).toEqual({ action: "list" });
		expect(isEvalControlRequest(request)).toBe(true);
		const args = { action: "list", summary: "  untouched  " };
		expect(f.tool.prepareArguments?.(args)).toEqual({ action: "list", summary: "  untouched  " });
	});

	it("lists an empty session without acquiring a kernel", async () => {
		const f = fixture();
		const listing = await f.list();
		expect(listing.content).toEqual([{ type: "text", text: "No eval cells are live; recent: none" }]);
		expect(listing.details.cells).toEqual([]);
		expect(renderLines(renderEvalCall({ action: "list" }, undefined, callContext()))).toEqual(["eval list"]);
		const rendered = renderLines(
			renderEvalResult(listing, { expanded: true, isPartial: false }, undefined, resultContext()),
		);
		expect(rendered).toEqual(["eval list", "No eval cells are live; recent: none"]);
		expect(f.manager.list()).toEqual({ live: [], recent: [] });
		expect(f.js.runs).toEqual([]);
		expect(f.notices).toEqual([]);
	});

	it("lists detached A, queued B and completed C across languages without consuming notifications", async () => {
		const f = fixture();
		const a = await f.submit("A");
		a.steering.abort();
		await a.execution;
		vi.setSystemTime(2000);
		const b = await f.submit("B");
		const c = await f.submit("C", "py");
		c.steering.abort();
		await c.execution;
		const terminalC = f.manager.waitForTerminal("C");
		f.py.completeDeferredRun(result("C", "c", 500));
		await terminalC;
		const before = f.manager.list();
		const listing = await f.list();
		expect(listing.content).toEqual([
			{
				type: "text",
				text: [
					"A js detached 1s - summary A",
					"B js queued 0s queued behind A - summary B",
					"C py completed 0s - summary C",
				].join("\n"),
			},
		]);
		expect(listing.details.cells).toEqual([
			{ cellId: "A", language: "js", state: "detached", startedAtMs: 1000, summary: "summary A" },
			{ cellId: "B", language: "js", state: "queued", startedAtMs: 2000, queuedBehind: ["A"], summary: "summary B" },
			{ cellId: "C", language: "py", state: "completed", startedAtMs: 2000, summary: "summary C" },
		]);
		expect(f.manager.list()).toEqual(before);
		expect(await f.list()).toEqual(listing);
		await f.manager.flushNotifications();
		expect(f.notices.map((notice) => notice.cellId)).toEqual(["C"]);
		await f.manager.stop("B");
		await b.execution;
	});

	it("uses a single-line 60-character code fallback for a legacy cell without a summary", async () => {
		const f = fixture();
		const cell = f.manager.create("legacy", { language: "py", code: `first\n${"x".repeat(80)}`, summary: "" });
		try {
			const listing = await f.list();
			expect(listing.content).toEqual([
				{
					type: "text",
					text: `legacy py queued 0s waiting for the py kernel to be ready - first ${"x".repeat(54)}`,
				},
			]);
		} finally {
			f.manager.fail(cell, new Error("fixture complete"));
		}
	});

	it("refuses reset with a typed error while A is live and leaves its kernel unchanged", async () => {
		const f = fixture();
		const a = await f.submit("A");
		a.steering.abort();
		await a.execution;
		// Resolve accidental admission in the mutation so failure is an assertion, not a timeout.
		const admitted = f.js.admitted("reset");
		const execution = f.tool.execute(
			"reset",
			{
				language: "js",
				code: "reset",
				summary: "reset",
				reset: true,
			},
			undefined,
			undefined,
			f.context,
		);
		const outcome = await Promise.race([
			execution.then(
				() => undefined,
				(error: unknown) => error,
			),
			admitted.then(() => undefined),
		]);
		try {
			expect(outcome).toBeInstanceOf(EvalKernelResetRefusedError);
			expect(outcome).toMatchObject({ name: "EvalKernelResetRefusedError", code: "eval_kernel_busy_reset_refused" });
			expect(f.js.resetCount).toBe(0);
			expect(f.js.interrupts).toEqual([]);
			expect(f.js.runs.map((run) => run.cellId)).toEqual(["A"]);
			expect(f.manager.peek("A").state).toBe("detached");
			expect(f.manager.peek("reset")).toMatchObject({
				state: "failed",
				result: { details: { isError: true, code: "eval_kernel_busy_reset_refused" } },
			});
			const stopped = await f.tool.execute(
				"stop-A",
				{ action: "stop", cell_id: "A" },
				undefined,
				undefined,
				f.context,
			);
			expect(stopped.details.cells?.[0]?.status).toBe("cancelled");
		} finally {
			await f.manager.stop("reset");
			if (outcome instanceof Error) await expect(execution).rejects.toBe(outcome);
			else await execution;
		}
	});

	it("resets an idle js kernel excluding the requesting queued cell and live cells in other languages", async () => {
		const f = fixture();
		const py = await f.submit("P", "py");
		py.steering.abort();
		await py.execution;
		const reset = await f.submit("reset", "js", true);
		f.js.completeDeferredRun(result("reset", "ok"));
		expect((await reset.execution).details.isError).not.toBe(true);
		expect(f.manager.peek("reset").state).toBe("completed");
		expect(f.js.resetCount).toBe(1);
		expect(f.manager.peek("P").state).toBe("detached");
	});

	// senpi#2259: a reset frees kernel memory but settled results of every language stay peekable.
	it("keeps every settled snapshot peekable after a successful js reset", async () => {
		const f = fixture();
		for (const [cellId, language] of [
			["A", "js"],
			["P", "py"],
			["B", "js"],
		] as const) {
			const run = await f.submit(cellId, language);
			(language === "js" ? f.js : f.py).completeDeferredRun(result(cellId, cellId));
			await run.execution;
		}
		const reset = await f.submit("reset", "js", true);
		f.js.completeDeferredRun(result("reset", "ok"));
		expect((await reset.execution).details.isError).not.toBe(true);
		expect(f.js.resetCount).toBe(1);
		expect(f.manager.list().recent.map((snapshot) => [snapshot.cellId, snapshot.language])).toEqual([
			["A", "js"],
			["P", "py"],
			["B", "js"],
			["reset", "js"],
		]);
		expect(f.manager.peek("A").state).toBe("completed");
	});

	it("refuses reset while another cell is queued before kernel acquisition", async () => {
		const f = fixture();
		const waiting = f.manager.create("waiting", { language: "js", code: "1", summary: "waiting" });
		try {
			const reset = f.tool.execute(
				"reset",
				{ language: "js", code: "1", summary: "reset", reset: true },
				undefined,
				undefined,
				f.context,
			);
			await expect(reset).rejects.toBeInstanceOf(EvalKernelResetRefusedError);
			expect(f.js.resetCount).toBe(0);
			expect(f.manager.peek("waiting").state).toBe("queued");
		} finally {
			f.manager.fail(waiting, new Error("fixture complete"));
		}
	});

	it("resets once after A and queued B settle", async () => {
		const f = fixture();
		const a = await f.submit("A");
		a.steering.abort();
		await a.execution;
		const b = await f.submit("B");
		const terminalA = f.manager.waitForTerminal("A");
		const startedB = f.js.started("B");
		f.js.completeDeferredRun(result("A", "a"));
		await Promise.all([terminalA, startedB]);
		f.js.completeDeferredRun(result("B", "b"));
		await b.execution;
		const reset = await f.submit("reset", "js", true);
		f.js.completeDeferredRun(result("reset", "ok"));
		expect((await reset.execution).details.isError).not.toBe(true);
		expect(f.js.resetCount).toBe(1);
	});

	it("preserves real JS state through a busy reset refusal and clears it after settlement", async () => {
		const kernel = new JavaScriptKernel({
			sessionId: "eval-list-reset-qa",
			cwd: process.cwd(),
			parallelPoolWidth: 2,
		});
		const manager = new EvalDetachedCellManager();
		const bridgeEntered = Promise.withResolvers<void>();
		const releaseBridge = Promise.withResolvers<void>();
		const steering = new AbortController();
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: { getKernel: async () => kernel },
			cellManager: manager,
			cellTimeoutSeconds: 30,
			executeTool: async () => {
				bridgeEntered.resolve();
				await releaseBridge.promise;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		});
		const context = { ...fakeExtensionContext(), mode: "tui" as const, steeringSignal: steering.signal };
		try {
			const execution = tool.execute(
				"real-A",
				{
					language: "js",
					code: 'globalThis.kept = 41; await tool.read({ path: "gate" }); kept + 1',
					summary: "retain sentinel",
				},
				undefined,
				undefined,
				context,
			);
			await Promise.race([bridgeEntered.promise, execution]);
			steering.abort();
			await execution;
			const listing = await tool.execute("list", { action: "list" }, undefined, undefined, context);
			expect(listing.details.cells).toMatchObject([{ cellId: "real-A", state: "detached" }]);
			const reset = tool.execute(
				"busy-reset",
				{ language: "js", code: "0", summary: "reset", reset: true },
				undefined,
				undefined,
				fakeExtensionContext(),
			);
			await expect(reset).rejects.toBeInstanceOf(EvalKernelResetRefusedError);
			const terminal = manager.waitForTerminal("real-A");
			releaseBridge.resolve();
			expect((await terminal).result.content).toEqual([{ type: "text", text: "42" }]);
			const cleared = await tool.execute(
				"idle-reset",
				{ language: "js", code: "typeof kept", summary: "reset", reset: true },
				undefined,
				undefined,
				fakeExtensionContext(),
			);
			expect(cleared.content).toEqual([{ type: "text", text: JSON.stringify("undefined") }]);
		} finally {
			releaseBridge.resolve();
			await manager.dispose();
			await kernel.close();
		}
	}, 15_000);
});
