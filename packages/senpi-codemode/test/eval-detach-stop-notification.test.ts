import { afterEach, describe, expect, it, vi } from "vitest";
import { EvalDetachedCellManager, type EvalDetachedCellNotification } from "../src/tool/detached-cell-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { interruptionStateNote } from "../src/tool/interrupt-note.ts";
import { FakeKernel, FakeManager, fakeExtensionContext } from "./eval/fakes.ts";

class NotificationRecorder {
	readonly notices: EvalDetachedCellNotification[] = [];

	notify(cells: readonly EvalDetachedCellNotification[]): void {
		this.notices.push(...cells);
	}
}

afterEach(() => {
	vi.useRealTimers();
});

async function stopDetachedCell(stateRetainedOnInterrupt: boolean): Promise<NotificationRecorder> {
	vi.useFakeTimers();
	const recorder = new NotificationRecorder();
	const manager = new EvalDetachedCellManager({ notifier: recorder });
	const kernel = new FakeKernel([]);
	kernel.stateRetainedOnInterrupt = stateRetainedOnInterrupt;
	const tool = createEvalTool({
		enabledLanguages: { js: true, py: false, rb: false, jl: false },
		kernelManager: new FakeManager([["js", kernel]]),
		cellTimeoutSeconds: 1,
		executeTool: vi.fn(),
		cellManager: manager,
	});
	const started = kernel.deferNextRun();
	const execution = tool.execute(
		"stop-notify",
		{ language: "js", code: "await forever", summary: "detach then stop", on_timeout: "detach" },
		undefined,
		undefined,
		{ ...fakeExtensionContext(), mode: "tui" as const },
	);
	await started;
	await vi.advanceTimersByTimeAsync(1_000);
	await execution;

	await manager.stop("stop-notify");
	await manager.flushNotifications();
	return recorder;
}

describe("detached cell stop notification", () => {
	it("Given a stop whose interrupt keeps the worker when the notification is delivered then it carries the retained outcome", async () => {
		const recorder = await stopDetachedCell(true);

		expect(recorder.notices).toHaveLength(1);
		expect(recorder.notices[0]?.content).toContain(interruptionStateNote("js", true));
	});

	it("Given a stop whose interrupt restarts the worker when the notification is delivered then it carries the lost outcome", async () => {
		const recorder = await stopDetachedCell(false);

		expect(recorder.notices).toHaveLength(1);
		expect(recorder.notices[0]?.content).toContain(interruptionStateNote("js", false));
	});
});
