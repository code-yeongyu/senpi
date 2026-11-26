import type { ExtensionToolContext } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvalDetachedCellManager, type EvalDetachedCellNotification } from "../src/tool/detached-cell-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { FakeKernel, result, SingleKernelManager } from "./eval/fakes.ts";
import { gate } from "./eval/written-files-barriers.ts";
import { writtenFilesHarness } from "./eval/written-files-fakes.ts";

afterEach(() => {
	vi.useRealTimers();
});

/**
 * One session with a detached cell `detached` whose code writes `src/a.ts` with plain fs. Every write hook dispatch
 * is recorded with the context it was dispatched through: each eval call has its own, so the recorded cell is the
 * call the host attributes the `tool_result` event to (`<that call's id>/reported-<n>`).
 */
async function detachedWriter() {
	vi.useFakeTimers();
	const harness = writtenFilesHarness();
	const { workspace } = harness;
	const hookStarted = gate();
	const releaseHook = gate();
	const dispatched: Array<{ readonly cell: string; readonly path: unknown }> = [];
	const notifications: EvalDetachedCellNotification[] = [];
	const contextOf = (cell: string): ExtensionToolContext => ({
		...harness.ctx,
		mode: "tui",
		reportToolResult: async (report) => {
			dispatched.push({ cell, path: report.input.path });
			hookStarted.open();
			await releaseHook.opened;
			return { toolCallId: `${cell}/reported-${dispatched.length}`, result: undefined, failures: [] };
		},
	});
	const kernel = new FakeKernel([result("later", "undefined")]);
	const manager = new EvalDetachedCellManager({ notifier: { notify: (cells) => notifications.push(...cells) } });
	const tool = createEvalTool({
		enabledLanguages: { js: true, py: false, rb: false, jl: false },
		kernelManager: new SingleKernelManager(kernel),
		cellTimeoutSeconds: 1,
		executeTool: async () => ({ content: [{ type: "text", text: "unused" }], details: {} }),
		cellManager: manager,
		writtenFiles: harness.writtenFiles,
	});
	const started = kernel.deferNextRun();
	const execution = tool.execute(
		"detached",
		{ language: "js", code: "writeFileSync('src/a.ts')", summary: "writes a file", on_timeout: "detach" },
		undefined,
		undefined,
		contextOf("detached"),
	);
	await started;
	await vi.advanceTimersByTimeAsync(1_000);
	const detachedResult = await execution;
	const finish = () => {
		workspace.write("src/a.ts", "export const a = 1;\n");
		kernel.completeDeferredRun({ type: "result", cellId: "detached", ok: true, durationMs: 0 });
	};
	return {
		workspace,
		kernel,
		manager,
		tool,
		notifications,
		dispatched,
		contextOf,
		hookStarted,
		releaseHook,
		finish,
		detachedResult,
	};
}

// senpi#7232: a detached cell's written files must reach the write hooks as that cell's own report, once, even when no
// other eval cell ever runs, without holding back the state the cell ended in.
describe("files a detached eval cell writes (senpi#7232)", () => {
	it("runs the write hooks once for the detached cell itself before its notification, with no later cell", async () => {
		const writer = await detachedWriter();
		expect(writer.manager.peek("detached").state).toBe("detached");

		writer.finish();
		await writer.hookStarted.opened;
		// The hook is still running: the cell has ended all the same, and a stop neither waits nor cancels the hook.
		const whileHooking = {
			peeked: writer.manager.peek("detached").state,
			stopped: (await writer.manager.stop("detached")).state,
			interrupts: writer.kernel.interrupts.length,
			notified: writer.notifications.length,
		};
		writer.releaseHook.open();
		await writer.manager.flushNotifications();

		const absolute = writer.workspace.absolute("src/a.ts");
		expect({
			whileHooking,
			dispatched: writer.dispatched,
			writtenFiles: writer.manager.peek("detached").result.details.writtenFiles,
			notified: writer.notifications.map((notification) => notification.cellId),
			notificationListsFile: writer.notifications[0]?.content.includes("- src/a.ts"),
			kernelRuns: writer.kernel.runs.map((run) => run.cellId),
		}).toEqual({
			whileHooking: { peeked: "completed", stopped: "completed", interrupts: 0, notified: 0 },
			dispatched: [{ cell: "detached", path: absolute }],
			writtenFiles: { files: ["src/a.ts"], total: 1, hooked: 1 },
			notified: ["detached"],
			notificationListsFile: true,
			kernelRuns: ["detached"],
		});
	});

	it("leaves nothing for a later cell to report or hook again", async () => {
		const writer = await detachedWriter();
		writer.releaseHook.open();
		writer.finish();
		await writer.manager.flushNotifications();

		const later = await writer.tool.execute(
			"later",
			{ language: "js", code: "1", summary: "writes nothing" },
			undefined,
			undefined,
			writer.contextOf("later"),
		);

		expect({
			dispatched: writer.dispatched,
			laterWrittenFiles: later.details.writtenFiles,
			detachedWrittenFiles: writer.manager.peek("detached").result.details.writtenFiles,
		}).toEqual({
			dispatched: [{ cell: "detached", path: writer.workspace.absolute("src/a.ts") }],
			laterWrittenFiles: undefined,
			detachedWrittenFiles: { files: ["src/a.ts"], total: 1, hooked: 1 },
		});
	});
});
