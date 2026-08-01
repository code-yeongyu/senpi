import type { AgentToolResult } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvalDetachedCellManager } from "../src/tool/detached-cell-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { EvalToolDetails } from "../src/tool/types.ts";
import { Deferred, FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";

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

function createTool(manager: EvalDetachedCellManager, kernelManager: FakeManager) {
	return createEvalTool({
		enabledLanguages: { js: true, py: false, rb: false, jl: false },
		kernelManager,
		cellTimeoutSeconds: 1,
		executeTool: async () => ({
			content: [{ type: "text", text: "loaded configuration" }],
			details: {},
		}),
		cellManager: manager,
	});
}

function requireCell(resultValue: AgentToolResult<EvalToolDetails>) {
	const cell = resultValue.details.cells?.[0];
	if (cell === undefined) throw new Error("expected one eval cell");
	return cell;
}

async function startRichDetachedCell() {
	vi.useFakeTimers();
	const manager = new EvalDetachedCellManager();
	const kernel = new FakeKernel([]);
	const tool = createTool(manager, new FakeManager([["js", kernel]]));
	const started = kernel.deferNextRun();
	const richUpdate = new Deferred<void>();
	const laterUpdate = new Deferred<void>();
	const source = "await new Promise(() => {})";
	const execution = tool.execute(
		"rich-cell",
		{
			language: "js",
			code: source,
			title: "collect progress",
			on_timeout: "detach",
		},
		undefined,
		(update) => {
			if (
				update.details.phase === "waiting" &&
				update.details.toolCalls.length === 1 &&
				update.details.statusEvents?.some((event) => event.op === "read")
			) {
				richUpdate.resolve(undefined);
			}
			if (update.details.phase === "finishing") laterUpdate.resolve(undefined);
		},
		interactiveContext(),
	);
	await started;
	kernel.emit({ type: "phase", title: "waiting" });
	kernel.emit({ type: "text", stream: "stdout", data: "before detach\n" });
	kernel.emit({ type: "status", event: { op: "read", path: "/tmp/input.json", chars: 12 } });
	kernel.emit({ type: "tool-call", callId: "read-1", toolName: "read", args: { path: "/tmp/input.json" } });
	await richUpdate.promise;
	await vi.advanceTimersByTimeAsync(1_000);
	await execution;
	return { kernel, laterUpdate, manager, source, tool };
}

describe("detached eval peek", () => {
	it("returns the latest rich detached result", async () => {
		const { manager, source, tool } = await startRichDetachedCell();

		const peek = await tool.execute(
			"peek-rich",
			{ action: "peek", cell_id: "rich-cell" },
			undefined,
			undefined,
			interactiveContext(),
		);
		const cell = requireCell(peek);

		expect(cell).toMatchObject({
			code: source,
			language: "js",
			status: "detached",
			title: "collect progress",
		});
		expect(cell.output).toContain("before detach");
		expect(cell.durationMs).toBeGreaterThanOrEqual(1_000);
		expect(peek.details.phase).toBe("waiting");
		expect(peek.details.toolCalls).toMatchObject([
			{ args: { path: "/tmp/input.json" }, callId: "read-1", name: "read", ok: true },
		]);
		expect(peek.details.statusEvents).toEqual([{ op: "read", path: "/tmp/input.json", chars: 12 }]);
		expect(peek.details.statusEvents).not.toContainEqual({ op: "detached", cellId: "rich-cell" });

		await manager.stop("rich-cell");
		await manager.flushNotifications();
	});

	it("keeps earlier live snapshots immutable across later kernel messages", async () => {
		const { kernel, laterUpdate, manager, tool } = await startRichDetachedCell();
		const first = await tool.execute(
			"peek-first",
			{ action: "peek", cell_id: "rich-cell" },
			undefined,
			undefined,
			interactiveContext(),
		);

		kernel.emit({ type: "phase", title: "finishing" });
		kernel.emit({ type: "text", stream: "stdout", data: "after detach\n" });
		kernel.emit({ type: "status", event: { op: "write", path: "/tmp/output.json", chars: 7 } });
		await laterUpdate.promise;
		const second = await tool.execute(
			"peek-second",
			{ action: "peek", cell_id: "rich-cell" },
			undefined,
			undefined,
			interactiveContext(),
		);

		expect(first.details.phase).toBe("waiting");
		expect(requireCell(first).output).not.toContain("after detach");
		expect(first.details.statusEvents).toEqual([{ op: "read", path: "/tmp/input.json", chars: 12 }]);
		expect(second.details.phase).toBe("finishing");
		expect(requireCell(second).output).toContain("after detach");
		expect(second.details.statusEvents).toContainEqual({ op: "write", path: "/tmp/output.json", chars: 7 });

		await manager.stop("rich-cell");
		await manager.flushNotifications();
	});

	it("gives the committed terminal result precedence over live state", async () => {
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager();
		const kernel = new FakeKernel([]);
		const tool = createTool(manager, new FakeManager([["js", kernel]]));
		const started = kernel.deferNextRun();
		const execution = tool.execute(
			"terminal-cell",
			{
				language: "js",
				code: "display({ answer: 42 })",
				title: "terminal result",
				on_timeout: "detach",
			},
			undefined,
			undefined,
			interactiveContext(),
		);
		await started;
		kernel.emit({ type: "phase", title: "finalizing" });
		kernel.emit({ type: "status", event: { op: "read", path: "/tmp/final.json", chars: 2 } });
		kernel.emit({
			type: "display",
			mimeType: "application/json",
			dataBase64: Buffer.from(JSON.stringify({ answer: 42 })).toString("base64"),
		});
		await vi.advanceTimersByTimeAsync(1_000);
		await execution;
		kernel.completeDeferredRun(result("terminal-cell", "done", 75));
		await manager.waitForTerminal("terminal-cell");

		const peek = await tool.execute(
			"peek-terminal",
			{ action: "peek", cell_id: "terminal-cell" },
			undefined,
			undefined,
			interactiveContext(),
		);

		expect(requireCell(peek)).toMatchObject({
			code: "display({ answer: 42 })",
			durationMs: 75,
			status: "complete",
			title: "terminal result",
		});
		expect(peek.details.phase).toBe("finalizing");
		expect(peek.details.jsonOutputs).toEqual([{ answer: 42 }]);
		expect(peek.details.statusEvents).toEqual([{ op: "read", path: "/tmp/final.json", chars: 2 }]);
		expect(textOf(peek)).toContain("done");
	});
});
