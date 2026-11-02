import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { TIMEOUT_PAUSE_OP, TIMEOUT_RESUME_OP } from "../src/bridge/reserved.ts";
import { JavaScriptRunQueue } from "../src/kernels/js/run-queue.ts";
import { SubprocessRunQueue } from "../src/kernels/shared/subprocess-queue.ts";
import { CellExecution, defaultTimeoutFactory } from "../src/tool/cell-execution.ts";
import { textOf, withQueueKernel } from "./eval/queue-control-fixture.ts";

type Queue = JavaScriptRunQueue | SubprocessRunQueue;

function settleActive(queue: Queue, cellId: string): void {
	const result = { type: "result", cellId, ok: true, durationMs: 1 } as const;
	if (queue instanceof JavaScriptRunQueue) {
		const run = queue.active;
		if (!run) throw new Error("expected an active JavaScript run");
		queue.releaseActive(run);
		queue.settle(run, result);
		return;
	}
	const run = queue.active;
	if (!run) throw new Error("expected an active subprocess run");
	queue.releaseActive(run);
	queue.settle(run, result);
}

function drain(queue: Queue): void {
	if (queue instanceof JavaScriptRunQueue) queue.settleAll("cleanup");
	else queue.settleAll(new Error("cleanup"));
}

describe.each([
	["JavaScript", (): Queue => new JavaScriptRunQueue()],
	["subprocess", (): Queue => new SubprocessRunQueue()],
] as const)("%s queue cell control", (_language, createQueue) => {
	it("settles B when removed, leaving A active and C queued", async () => {
		const queue = createQueue();
		const a = queue.enqueue({ cellId: "A", code: "" });
		const b = queue.enqueue({ cellId: "B", code: "" });
		const c = queue.enqueue({ cellId: "C", code: "" });
		queue.startNext(10);

		expect(queue.remove("B", "cancel B")).toBe(true);

		await expect(b).resolves.toEqual({
			type: "result",
			cellId: "B",
			ok: false,
			error: { message: "cancel B" },
			durationMs: 0,
		});
		expect(queue.snapshot()).toEqual({ activeCellId: "A", queuedCellIds: ["C"] });
		drain(queue);
		await Promise.all([a, c]);
	});

	it("signals activation once for A then C, never for removed B", async () => {
		const queue = createQueue();
		const started: string[] = [];
		const runs = ["A", "B", "C"].map((cellId) =>
			queue.enqueue({
				cellId,
				code: "",
				onStarted: () => {
					started.push(cellId);
				},
			}),
		);
		queue.startNext(10);
		expect(started).toEqual(["A"]);
		expect(queue.startNext(20)).toBeNull();

		expect(queue.remove("B", "cancel B")).toBe(true);
		settleActive(queue, "A");
		queue.startNext(30);

		expect(started).toEqual(["A", "C"]);
		drain(queue);
		await Promise.all(runs);
	});

	it("refuses to remove an active or unknown cell", async () => {
		const queue = createQueue();
		const a = queue.enqueue({ cellId: "A", code: "" });
		const b = queue.enqueue({ cellId: "B", code: "" });
		queue.startNext(10);

		expect(queue.remove("A", "active")).toBe(false);
		expect(queue.remove("missing", "unknown")).toBe(false);
		expect(queue.remove("B", "queued")).toBe(true);
		expect(queue.remove("B", "already gone")).toBe(false);

		expect(queue.snapshot()).toEqual({ activeCellId: "A", queuedCellIds: [] });
		drain(queue);
		await Promise.all([a, b]);
	});
});

describe.each(["js", "py", "rb", "jl"] as const)("%s targeted kernel control", (language) => {
	it("cancels only queued C while A stays active and the runtime is never retired", async () => {
		await withQueueKernel(language, async ({ kernel, held, release, code, child }) => {
			const a = kernel.run({ cellId: "A", code });
			await held;
			const c = kernel.run({ cellId: "C", code: "" });

			const handle = await kernel.interrupt("cancel C", "C");

			expect(await handle.stateRetained).toBe(true);
			await expect(c).resolves.toMatchObject({ cellId: "C", ok: false });
			expect(kernel.queueSnapshot()).toEqual({ activeCellId: "A", queuedCellIds: [] });
			expect(child?.killSignals ?? []).toEqual([]);
			release();
			await expect(a).resolves.toMatchObject({ ok: true, valueRepr: "42" });
		});
	});

	it("reports cell not found for an unknown id without touching the active run", async () => {
		await withQueueKernel(language, async ({ kernel, held, release, code }) => {
			const a = kernel.run({ cellId: "A", code });
			await held;

			const handle = await kernel.interrupt("late cancel", "unknown");

			expect(handle.note).toBe("cell not found");
			expect(await handle.stateRetained).toBe(true);
			expect(kernel.cancelQueued("A", "wrong target")).toBe(false);
			expect(kernel.cancelQueued("unknown", "wrong target")).toBe(false);
			release();
			await expect(a).resolves.toMatchObject({ ok: true });
		});
	});

	it("aborts queued B through CellExecution without stopping A or executing B", async () => {
		await withQueueKernel(language, async ({ kernel, held, release, code, sentinelCode, sentinel, child }) => {
			const a = kernel.run({ cellId: "A", code });
			await held;
			const controller = new AbortController();
			const execution = new CellExecution({
				callerSignal: controller.signal,
				cellId: "B",
				timeoutFactory: defaultTimeoutFactory,
				onAbort: () => undefined,
			});
			execution.setKernel(kernel);
			const b = kernel.run({ cellId: "B", code: sentinelCode });
			const aborted = expect(execution.wait(b)).rejects.toThrow("cancel B");
			try {
				controller.abort("cancel B");

				await aborted;
				const handle = await execution.interruptHandle;
				expect(await handle?.stateRetained).toBe(true);
				expect(child?.killSignals ?? []).toEqual([]);
				release();
				await expect(a).resolves.toMatchObject({ ok: true });
				await expect(b).resolves.toMatchObject({ cellId: "B", ok: false });
				expect(child?.runCellIds ?? ["A"]).toEqual(["A"]);
				expect(existsSync(sentinel)).toBe(false);
			} finally {
				execution.finish();
			}
		});
	});
});

describe.each(["js", "py"] as const)("%s live runtime queue and routing", (language) => {
	it("completes A and C on the same runtime after dequeuing B", async () => {
		await withQueueKernel(language, async ({ kernel, held, release, code, sentinelCode, sentinel }) => {
			const started: string[] = [];
			const input = (cellId: string, cellCode: string) => ({
				cellId,
				code: cellCode,
				onStarted: () => {
					started.push(cellId);
				},
			});
			const a = kernel.run(input("A", code));
			await held;
			const b = kernel.run(input("B", sentinelCode));
			const c = kernel.run(input("C", language === "py" ? "queue_value + 1" : "queueValue + 1"));

			expect(kernel.cancelQueued("B", "cancel B")).toBe(true);

			await expect(b).resolves.toMatchObject({ cellId: "B", ok: false, durationMs: 0 });
			expect(started).toEqual(["A"]);
			release();
			await expect(a).resolves.toMatchObject({ ok: true, valueRepr: "42" });
			await expect(c).resolves.toMatchObject({ ok: true, valueRepr: "43" });
			expect(started).toEqual(["A", "C"]);
			expect(existsSync(sentinel)).toBe(false);
			expect(kernel.queueSnapshot()).toEqual({ activeCellId: null, queuedCellIds: [] });

			await expect(kernel.run({ cellId: "D", code: sentinelCode })).resolves.toMatchObject({ ok: true });
			expect(existsSync(sentinel)).toBe(true);
		});
	});

	it("routes A's own output and result to A's callback, never to queued B's", async () => {
		await withQueueKernel(language, async ({ kernel, held, release, code, lifecycle }) => {
			const seenA: KernelToHostMessage[] = [];
			const seenB: KernelToHostMessage[] = [];
			const a = kernel.run({
				cellId: "A",
				code,
				onMessage: (message) => {
					seenA.push(message);
				},
			});
			await held;
			const b = kernel.run({
				cellId: "B",
				code: "print('B-only')",
				onMessage: (message) => {
					seenB.push(message);
				},
			});

			release();

			await expect(a).resolves.toMatchObject({ ok: true });
			await expect(b).resolves.toMatchObject({ ok: true });
			expect(textOf(seenA)).toContain("A-after");
			expect(textOf(seenB)).toContain("B-only");
			expect(textOf(seenA)).not.toContain("B-only");
			expect(textOf(seenB)).not.toContain("A-after");
			expect(seenA).toContainEqual(expect.objectContaining({ type: "result", cellId: "A" }));
			expect(seenB).toContainEqual(expect.objectContaining({ type: "result", cellId: "B" }));
			expect(seenA.filter((message) => message.type === "result")).toHaveLength(1);
			expect(seenA).toContainEqual({ type: "status", event: { op: TIMEOUT_PAUSE_OP } });
			expect(seenA).toContainEqual({ type: "status", event: { op: TIMEOUT_RESUME_OP } });
			expect(seenB).not.toContainEqual({ type: "status", event: { op: TIMEOUT_PAUSE_OP } });
			expect(lifecycle.some((message) => message.type === "ready")).toBe(true);
			expect(
				lifecycle.filter(
					(message) => message.type === "text" || message.type === "status" || message.type === "result",
				),
			).toEqual([]);
		});
	});
});
