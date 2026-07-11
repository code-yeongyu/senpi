import { afterEach, describe, expect, it, vi } from "vitest";
import { PythonKernel } from "../src/kernels/py/kernel.ts";
import { FakeChild, type ResultMessage, startFakeKernel, startFakeKernelSequence } from "./py-kernel/fixtures.ts";

function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
	return promise.then(
		(value) => ({ status: "fulfilled", value }),
		(reason: unknown) => ({ status: "rejected", reason }),
	);
}

describe("PythonKernel lifecycle regressions", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("cancels queued Python cells before writing them to the active process", async () => {
		vi.useFakeTimers();
		const child = new FakeChild({ autoReady: false, autoRun: false });
		const kernel = await startFakeKernel(child, "queued-interrupt-session");
		try {
			const active = kernel.run({ cellId: "active-cell", code: "while True: pass", timeoutMs: 60_000 });
			const queued = kernel.run({ cellId: "queued-cell", code: "queued_side_effect = 84", timeoutMs: 60_000 });
			await vi.advanceTimersByTimeAsync(0);

			await kernel.interrupt("manual stop");
			const [activeResult, queuedResult] = await Promise.all([active, queued]);

			expect(child.runMessages.map((message) => message.cellId)).toEqual(["active-cell"]);
			expect(activeResult).toMatchObject({ ok: false, error: { message: "Eval interrupted: manual stop" } });
			expect(queuedResult).toMatchObject({ ok: false, error: { message: "Eval interrupted: manual stop" } });
		} finally {
			await kernel.close();
		}
	});

	it("starts work after a timeout only after the retired child is replaced", async () => {
		vi.useFakeTimers();
		const first = new FakeChild({ autoReady: false, autoRun: false });
		const second = new FakeChild();
		const { kernel, spawned } = await startFakeKernelSequence([first, second], "timeout-retirement-session");
		try {
			const timedOut = kernel.run({ cellId: "timed-out-cell", code: "while True: pass", timeoutMs: 5 });
			await vi.advanceTimersByTimeAsync(5);
			await expect(timedOut).resolves.toMatchObject({
				ok: false,
				error: { message: "Python kernel timed out after 5ms" },
			});

			const next = kernel.run({ cellId: "replacement-cell", code: "40 + 2", timeoutMs: 10_000 });
			const nextResult = await next;

			expect(first.runMessages.map((message) => message.cellId)).toEqual(["timed-out-cell"]);
			expect(spawned).toEqual([first, second]);
			expect(nextResult).toMatchObject({ ok: true, valueRepr: "fake" });
		} finally {
			await kernel.close();
		}
	});

	it("ignores stdout and stderr emitted by a retired Python child", async () => {
		vi.useFakeTimers();
		const first = new FakeChild({ autoReady: false, autoRun: false });
		const second = new FakeChild();
		const observed: string[] = [];
		const { kernel } = await startFakeKernelSequence([first, second], "retired-output-session", (message) => {
			if (message.type === "text") observed.push(message.data);
		});
		try {
			const reset = kernel.reset();
			await reset;

			first.emitMessage({ type: "text", stream: "stdout", data: "late retired stdout\n" });
			first.stderr.emit("data", "late retired stderr\n");

			expect(observed).toEqual([]);
		} finally {
			await kernel.close();
		}
	});

	it("settles a timeout once when result, abort, and exit collide", async () => {
		vi.useFakeTimers();
		const child = new FakeChild({ autoReady: false, autoRun: false });
		const kernel = await startFakeKernel(child, "timeout-collision-session");
		const settlements: ResultMessage[] = [];
		try {
			const pending = kernel
				.run({ cellId: "collision-cell", code: "while True: pass", timeoutMs: 10 })
				.then((result) => {
					settlements.push(result);
					return result;
				});
			await vi.advanceTimersByTimeAsync(10);
			const result = await pending;

			child.emitMessage({ type: "result", cellId: "collision-cell", ok: true, valueRepr: "late", durationMs: 1 });
			await kernel.interrupt("late abort");
			child.finish(1, null);
			await vi.advanceTimersByTimeAsync(0);

			expect(result).toMatchObject({
				ok: false,
				error: { message: "Python kernel timed out after 10ms" },
				durationMs: 10,
			});
			expect(settlements).toHaveLength(1);
			expect(child.killSignals).toEqual(["SIGKILL"]);
			expect(child.listeners.get("exit") ?? []).toHaveLength(0);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			await kernel.close();
		}
	});

	it("measures crash duration with a monotonic clock when wall time moves backward", async () => {
		vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValue(500);
		vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValue(125);
		const child = new FakeChild({ autoReady: false, autoRun: false });
		const kernel = await startFakeKernel(child, "monotonic-duration-session");
		const pending = kernel.run({ cellId: "monotonic-cell", code: "pass", timeoutMs: 10_000 });
		await new Promise<void>((resolve) => setImmediate(resolve));

		child.finish(1, null);

		await expect(pending).resolves.toMatchObject({
			ok: false,
			error: { message: "Python kernel died" },
			durationMs: 25,
		});
	});

	it("fails closed without spawning a replacement when final SIGKILL grace expires", async () => {
		vi.useFakeTimers();
		const stuck = new FakeChild({ remainAliveOnSigkill: true });
		const replacement = new FakeChild();
		const { kernel, spawned } = await startFakeKernelSequence([stuck, replacement], "failed-retirement-session");

		const reset = settle(kernel.reset());
		await vi.advanceTimersByTimeAsync(500);
		const resetResult = await reset;

		expect(resetResult.status).toBe("rejected");
		if (resetResult.status === "rejected") {
			expect(resetResult.reason).toMatchObject({ name: "PythonKernelRetirementError" });
		}
		await expect(kernel.run({ cellId: "blocked", code: "1", timeoutMs: 1_000 })).rejects.toThrow(/exit/i);
		expect(spawned).toEqual([stuck]);
		expect(stuck.killSignals).toEqual(["SIGKILL"]);
		stuck.finish(null, "SIGKILL");
	});

	it("retires delayed reset startup after close and settles active and queued work once", async () => {
		const activeStarted = Promise.withResolvers<void>();
		const secondSpawned = Promise.withResolvers<void>();
		const settlements = new Map<string, number>();
		const initial = new FakeChild({ autoRun: false, onRun: () => activeStarted.resolve() });
		const delayed = new FakeChild({ autoReady: false, autoRun: false });
		let spawnCount = 0;
		const started = PythonKernel.start({
			interpreterPath: "python3",
			sessionId: "reset-close-session",
			cwd: process.cwd(),
			connection: { port: 1, token: "t" },
			spawnProcess: () => {
				spawnCount += 1;
				if (spawnCount === 2) secondSpawned.resolve();
				return spawnCount === 1 ? initial : delayed;
			},
		});
		const kernel = await started;
		const observe = (label: string, promise: Promise<ResultMessage>) =>
			promise.finally(() => settlements.set(label, (settlements.get(label) ?? 0) + 1));
		const active = observe("active", kernel.run({ cellId: "active", code: "block", timeoutMs: 5_000 }));
		await activeStarted.promise;

		const reset = settle(kernel.reset());
		await secondSpawned.promise;
		const queued = observe("queued", kernel.run({ cellId: "queued", code: "next", timeoutMs: 5_000 }));
		const close = kernel.close();
		delayed.emitMessage({ type: "ready" });
		const [activeResult, queuedResult, resetResult] = await Promise.all([active, queued, reset]);
		await close;

		expect(activeResult).toMatchObject({ ok: false, error: { message: "Python kernel reset" } });
		expect(queuedResult).toMatchObject({ ok: false, error: { message: "Python kernel closed" } });
		expect(resetResult.status).toBe("rejected");
		expect(spawnCount).toBe(2);
		expect(delayed.killSignals).toEqual(["SIGKILL"]);
		expect(delayed.runMessages).toEqual([]);
		expect(settlements).toEqual(
			new Map([
				["active", 1],
				["queued", 1],
			]),
		);
		delayed.emitMessage({ type: "result", cellId: "queued", ok: true, valueRepr: "late", durationMs: 1 });
		delayed.emit("exit", null, "SIGKILL");
		expect(settlements.get("queued")).toBe(1);
	});

	it("does not let a retired child settle a current-generation run", async () => {
		const replacementStarted = Promise.withResolvers<void>();
		const first = new FakeChild({ autoRun: false });
		const second = new FakeChild({ autoRun: false, onRun: () => replacementStarted.resolve() });
		const { kernel } = await startFakeKernelSequence([first, second], "stale-result-session");
		await kernel.reset();
		let settlements = 0;
		const pending = kernel.run({ cellId: "same-cell", code: "current", timeoutMs: 5_000 }).then((result) => {
			settlements += 1;
			return result;
		});
		await replacementStarted.promise;

		first.emitMessage({ type: "result", cellId: "same-cell", ok: true, valueRepr: "stale", durationMs: 1 });
		expect(settlements).toBe(0);
		second.emitMessage({ type: "result", cellId: "same-cell", ok: true, valueRepr: "current", durationMs: 1 });

		await expect(pending).resolves.toMatchObject({ ok: true, valueRepr: "current" });
		expect(settlements).toBe(1);
		await kernel.close();
	});
});
