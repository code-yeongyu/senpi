import type { ExtensionToolContext } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WakeSourceState } from "../src/extension/wake-source-state.ts";
import { EvalDetachedCellManager, type EvalDetachedCellSnapshot } from "../src/tool/detached-cell-manager.ts";
import { DetachedNotificationQueue } from "../src/tool/detached-notification-queue.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { FakeKernel, fakeExtensionContext, result, SingleKernelManager } from "./eval/fakes.ts";
import { gate } from "./eval/written-files-barriers.ts";
import { writtenFilesHarness } from "./eval/written-files-fakes.ts";

afterEach(() => {
	vi.useRealTimers();
});

async function endedSnapshot(): Promise<EvalDetachedCellSnapshot> {
	const manager = new EvalDetachedCellManager();
	const tool = createEvalTool({
		enabledLanguages: { js: true, py: false, rb: false, jl: false },
		kernelManager: new SingleKernelManager(new FakeKernel([result("ended", "1")])),
		cellTimeoutSeconds: 1,
		executeTool: vi.fn(),
		cellManager: manager,
	});
	await tool.execute("ended", { language: "js", code: "1", summary: "ended" }, undefined, undefined, {
		...fakeExtensionContext(),
	});
	const snapshot = manager.peek("ended");
	if (snapshot === undefined) throw new Error("the ended cell left no snapshot");
	return snapshot;
}

// The engine takes custody of a notification only when it is delivered, so a detached cell whose notification waits
// for its written files must stay counted as background work until then (fused-equivalence E08 on senpi#7276). It is
// counted through the wake source, which the engine retires on restore, not through an extension-opened obligation.
describe("a detached cell whose notification waits to settle stays background work (senpi#7232)", () => {
	it("keeps the cell in the wake-source count from its end until the notification was handed over", async () => {
		vi.useFakeTimers();
		const harness = writtenFilesHarness();
		const hookStarted = gate();
		const releaseHook = gate();
		const events: string[] = [];
		const manager = new EvalDetachedCellManager({
			notifier: { notify: (cells) => events.push(...cells.map((cell) => `notify:${cell.cellId}`)) },
			onWakeSourceState: (state: WakeSourceState) =>
				events.push(`wake:${state.items?.map((item) => item.id).join(",") ?? ""}`),
		});
		const ctx: ExtensionToolContext = {
			...harness.ctx,
			mode: "tui",
			reportToolResult: async () => {
				hookStarted.open();
				await releaseHook.opened;
				return { toolCallId: "writer/reported-1", result: undefined, failures: [] };
			},
		};
		const kernel = new FakeKernel([]);
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: new SingleKernelManager(kernel),
			cellTimeoutSeconds: 1,
			executeTool: vi.fn(),
			cellManager: manager,
			writtenFiles: harness.writtenFiles,
		});
		const started = kernel.deferNextRun();
		const call = tool.execute(
			"writer",
			{ language: "js", code: "await work()", summary: "writer", on_timeout: "detach" },
			undefined,
			undefined,
			ctx,
		);
		await started;
		await vi.advanceTimersByTimeAsync(1_000);
		await call;
		const beforeEnd = events.length;

		harness.workspace.write("src/a.ts", "export const a = 1;\n");
		kernel.completeDeferredRun({ type: "result", cellId: "writer", ok: true, durationMs: 0 });
		await hookStarted.opened;
		const whileHeld = events.slice(beforeEnd);
		releaseHook.open();
		await manager.flushNotifications();

		expect({ whileHeld, afterEnd: events.slice(beforeEnd) }).toEqual({
			whileHeld: ["wake:writer"],
			afterEnd: ["wake:writer", "notify:writer", "wake:"],
		});
	});

	it("calls onDelivered after the notifier, also when the settlement rejects", async () => {
		const snapshot = await endedSnapshot();
		const events: string[] = [];
		const queue = new DetachedNotificationQueue({
			notify: (cells) => events.push(...cells.map((cell) => `notify:${cell.cellId}`)),
		});

		queue.enqueue({
			snapshot: () => snapshot,
			ready: Promise.reject(new Error("settlement failed")),
			onDelivered: () => events.push("delivered"),
		});
		await queue.flush();

		expect(events).toEqual(["notify:ended", "delivered"]);
	});

	it("calls onDelivered when building the notification fails", async () => {
		const events: string[] = [];
		const queue = new DetachedNotificationQueue({ notify: () => events.push("notify") });

		queue.enqueue({
			snapshot: () => Promise.reject(new Error("snapshot failed")),
			ready: Promise.resolve(),
			onDelivered: () => events.push("delivered"),
		});
		await queue.flush().catch(() => undefined);

		expect(events).toEqual(["delivered"]);
	});

	it("still runs every onDelivered of a batch when one of them throws", async () => {
		const snapshot = await endedSnapshot();
		const events: string[] = [];
		const queue = new DetachedNotificationQueue({ notify: () => events.push("notify") });

		queue.enqueue({
			snapshot: () => snapshot,
			onDelivered: () => {
				throw new Error("release failed");
			},
		});
		queue.enqueue({ snapshot: () => snapshot, onDelivered: () => events.push("second delivered") });
		const flushed = await queue.flush().then(
			() => "resolved",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);

		expect({ events, flushed }).toEqual({ events: ["notify", "second delivered"], flushed: "release failed" });
	});
});
