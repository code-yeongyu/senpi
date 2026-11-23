import { describe, expect, it, vi } from "vitest";
import { createSettleHold } from "../src/extension/settle-hold.ts";
import { EvalDetachedCellManager, type EvalDetachedCellSnapshot } from "../src/tool/detached-cell-manager.ts";
import { DetachedNotificationQueue } from "../src/tool/detached-notification-queue.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { FakeKernel, fakeExtensionContext, result, SingleKernelManager } from "./eval/fakes.ts";
import { gate } from "./eval/written-files-barriers.ts";

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

function recordingQueue(events: string[]): DetachedNotificationQueue {
	let holds = 0;
	return new DetachedNotificationQueue(
		{ notify: (cells) => events.push(...cells.map((cell) => `notify:${cell.cellId}`)) },
		() => {
			holds += 1;
			const hold = holds;
			events.push(`hold:${hold}`);
			return () => events.push(`release:${hold}`);
		},
	);
}

// The engine takes custody of a notification only when it is delivered, so a notification waiting for its cell's
// written files must hold the session meanwhile (fused-equivalence E08 on senpi#7276).
describe("a detached notification waiting to settle holds the session (senpi#7232)", () => {
	it("holds from enqueue until the notification was handed over, then releases once", async () => {
		const snapshot = await endedSnapshot();
		const events: string[] = [];
		const queue = recordingQueue(events);
		const settled = gate();

		queue.enqueue({ snapshot: () => snapshot, ready: settled.opened });
		const whileSettling = [...events];
		settled.open();
		await queue.flush();

		expect({ whileSettling, after: events }).toEqual({
			whileSettling: ["hold:1"],
			after: ["hold:1", "notify:ended", "release:1"],
		});
	});

	it("still delivers and releases when the settlement rejects", async () => {
		const snapshot = await endedSnapshot();
		const events: string[] = [];
		const queue = recordingQueue(events);

		queue.enqueue({ snapshot: () => snapshot, ready: Promise.reject(new Error("settlement failed")) });
		await queue.flush();

		expect(events).toEqual(["hold:1", "notify:ended", "release:1"]);
	});

	it("takes no hold for a notification that does not wait", async () => {
		const snapshot = await endedSnapshot();
		const events: string[] = [];
		const queue = recordingQueue(events);

		queue.enqueue({ snapshot: () => snapshot });
		await queue.flush();

		expect(events).toEqual(["notify:ended"]);
	});

	it("releases when building the notification fails", async () => {
		const events: string[] = [];
		const queue = recordingQueue(events);

		queue.enqueue({
			snapshot: () => Promise.reject(new Error("snapshot failed")),
			ready: Promise.resolve(),
		});
		await queue.flush().catch(() => undefined);

		expect(events).toEqual(["hold:1", "release:1"]);
	});

	it("opens a background obligation under a codemode key and closes it as consumed", () => {
		const opened: { key: string; kind: string }[] = [];
		const closed: string[] = [];
		const hold = createSettleHold({
			obligations: {
				open: (key, kind) => {
					opened.push({ key, kind });
					return { close: (reason) => closed.push(reason) };
				},
			},
		});

		const release = hold?.();
		release?.();

		expect({ opened, closed, absentHost: createSettleHold(undefined) }).toEqual({
			opened: [{ key: expect.stringMatching(/^eval-settle:[0-9a-f-]{36}$/), kind: "background" }],
			closed: ["consumed"],
			absentHost: undefined,
		});
	});
});
