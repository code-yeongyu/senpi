import { afterEach, describe, expect, it, vi } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { EvalDetachedCellManager, type EvalDetachedCellNotification } from "../src/tool/detached-cell-manager.ts";
import { executeEvalControl } from "../src/tool/detached-eval-result.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { renderEvalResult } from "../src/tool/render.ts";
import type { EvalKernel, EvalKernelManager, EvalKernelRunInput, EvalToolDetails } from "../src/tool/types.ts";
import { FakeKernel, FakeManager, fakeExtensionContext } from "./eval/fakes.ts";
import { evalResult, renderLines, resultContext, stripAnsi } from "./eval-render-fixtures.ts";

afterEach(() => {
	vi.useRealTimers();
});

function textOf(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
	return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

function detachingTool(manager: EvalDetachedCellManager, kernelManager: EvalKernelManager) {
	return createEvalTool({
		enabledLanguages: { js: true, py: false, rb: false, jl: false },
		kernelManager,
		cellTimeoutSeconds: 1,
		executeTool: vi.fn(),
		cellManager: manager,
	});
}

function runDetaching(tool: ReturnType<typeof createEvalTool>, cellId: string, summary: string) {
	return tool.execute(
		cellId,
		{ language: "js", code: "await forever", summary, on_timeout: "detach" },
		undefined,
		undefined,
		{ ...fakeExtensionContext(), mode: "tui" as const },
	);
}

/** A kernel still bringing its worker up: the cell is first in its queue and nothing is running yet. */
class StartingKernel extends FakeKernel {
	readonly #cells: string[] = [];

	override async run(input: EvalKernelRunInput): Promise<Extract<KernelToHostMessage, { type: "result" }>> {
		this.#cells.push(input.cellId);
		return await new Promise(() => {});
	}

	override queueSnapshot(): ReturnType<EvalKernel["queueSnapshot"]> {
		return { activeCellId: null, queuedCellIds: [...this.#cells] };
	}
}

describe("detached cell terminal truth", () => {
	it("Given a running detached cell when it is stopped then its notification shows the cancelled outcome without a running frame (#2791)", async () => {
		vi.useFakeTimers();
		const notices: EvalDetachedCellNotification[] = [];
		const manager = new EvalDetachedCellManager({ notifier: { notify: (cells) => notices.push(...cells) } });
		const kernel = new FakeKernel([]);
		const started = kernel.deferNextRun();
		const execution = runDetaching(
			detachingTool(manager, new FakeManager([["js", kernel]])),
			"stop-truth",
			"detach then stop",
		);
		await started;
		await vi.advanceTimersByTimeAsync(1_000);
		await execution;

		const stopped = await manager.stop("stop-truth");
		await manager.flushNotifications();

		expect(stopped.state).toBe("cancelled");
		expect(textOf(stopped.result)).not.toMatch(/running/u);
		expect(stopped.result.details.cells?.[0]?.status).toBe("cancelled");
		expect(notices).toHaveLength(1);
		expect(notices[0]?.content).toContain("cancelled.");
		expect(notices[0]?.content).not.toMatch(/cells running|detach then stop running/u);
	});

	it("Given a cell first in line while its kernel is still starting when it detaches then it says it waits for the kernel instead of an empty predecessor (#2790)", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager({ notifier: { notify: () => {} } });
		const execution = runDetaching(
			detachingTool(manager, new FakeManager([["js", new StartingKernel([])]])),
			"waits-for-kernel",
			"detach while starting",
		);
		await vi.advanceTimersByTimeAsync(1_000);
		const text = textOf(await execution);
		const status = textOf(manager.peek("waits-for-kernel").result);

		expect(text).not.toMatch(/queued behind\s+in|runs after\s+and/u);
		expect(text).toContain("waiting for the js kernel to be ready");
		expect(status).toContain("waiting for the js kernel to be ready");
		const listed = textOf(await executeEvalControl(manager, { action: "list" }));
		expect(listed).toMatch(
			/waits-for-kernel js detached \d+s waiting for the js kernel to be ready - detach while starting/u,
		);
		await manager.stop("waits-for-kernel");
	});

	it("Given a cell queued behind a running cell when it detaches then it still names that predecessor", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager({ notifier: { notify: () => {} } });
		const kernel = new FakeKernel([]);
		kernel.queueSnapshot = () => ({ activeCellId: "first-cell", queuedCellIds: ["named-wait"] });
		kernel.run = async () => await new Promise(() => {});
		const execution = runDetaching(
			detachingTool(manager, new FakeManager([["js", kernel]])),
			"named-wait",
			"behind another",
		);
		await vi.advanceTimersByTimeAsync(1_000);

		expect(textOf(await execution)).toContain("queued behind first-cell in the js kernel");
		await manager.stop("named-wait");
	});

	it("Given a detached cell whose run throws when it is peeked and notified then the error text is shown with its output", async () => {
		vi.useFakeTimers();
		const notices: EvalDetachedCellNotification[] = [];
		const manager = new EvalDetachedCellManager({ notifier: { notify: (cells) => notices.push(...cells) } });
		const kernel = new FakeKernel([{ type: "text", stream: "stdout", data: "partial-output\n" }]);
		const started = kernel.deferNextRun();
		const execution = runDetaching(
			detachingTool(manager, new FakeManager([["js", kernel]])),
			"throws",
			"a cell that throws",
		);
		await started;
		await vi.advanceTimersByTimeAsync(1_000);
		await execution;

		kernel.failDeferredRun(new Error("PROBE-KERNEL-EXPLODED"));
		await manager.waitForTerminal("throws");
		await manager.flushNotifications();

		expect(textOf(manager.peek("throws").result)).toContain("PROBE-KERNEL-EXPLODED");
		expect(notices[0]?.content).toContain("PROBE-KERNEL-EXPLODED");
	});

	it("Given a stopped predecessor still winding down in its kernel when a new cell detaches then the new cell names it", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager({ notifier: { notify: () => {} } });
		const kernel = new FakeKernel([]);
		kernel.queueSnapshot = () => ({ activeCellId: "stopped-but-winding-down", queuedCellIds: ["after-stop"] });
		kernel.run = async () => await new Promise(() => {});
		const execution = runDetaching(
			detachingTool(manager, new FakeManager([["js", kernel]])),
			"after-stop",
			"after a stop",
		);
		await vi.advanceTimersByTimeAsync(1_000);

		expect(textOf(await execution)).toContain("queued behind stopped-but-winding-down in the js kernel");
		await manager.stop("after-stop");
	});

	it("Given a queued cell with nothing ahead of it when its result renders then the header says it waits for the kernel", () => {
		const details: EvalToolDetails = {
			language: "js",
			durationMs: 0,
			toolCalls: [],
			truncated: false,
			cells: [
				{ index: 0, code: "1", language: "js", output: "", status: "queued", durationMs: 0, queuedBehind: [] },
			],
		};

		const lines = renderLines(
			renderEvalResult(
				evalResult(details, ""),
				{ expanded: false, isPartial: true },
				undefined,
				resultContext(undefined, false),
			),
		).map(stripAnsi);

		expect(lines[0]).toContain("waiting for the js kernel to be ready");
	});
});
