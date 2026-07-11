import { afterEach, describe, expect, it, vi } from "vitest";
import { PythonKernel } from "../src/kernels/py/kernel.ts";
import { FakeChild, startFakeKernel, startFakeKernelSequence } from "./py-kernel/fixtures.ts";

function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
	return promise.then(
		(value) => ({ status: "fulfilled", value }),
		(reason: unknown) => ({ status: "rejected", reason }),
	);
}

describe("PythonKernel child error lifecycle", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("owns a startup child error without exit and retires the failed child", async () => {
		vi.useFakeTimers();
		const child = new FakeChild({ autoReady: false, autoRun: false, rejectKill: true });
		let settlements = 0;
		const started = settle(
			PythonKernel.start({
				interpreterPath: "python3",
				sessionId: "startup-error-session",
				cwd: process.cwd(),
				connection: { port: 1, token: "t" },
				startupTimeoutMs: 10_000,
				spawnProcess: () => child,
			}),
		).then((result) => {
			settlements += 1;
			return result;
		});

		expect(() => child.fail(new Error("python spawn channel failed"))).not.toThrow();
		await vi.advanceTimersByTimeAsync(0);
		const result = await started;

		expect(result.status).toBe("rejected");
		if (result.status === "rejected") expect(result.reason).toMatchObject({ message: "python spawn channel failed" });
		expect(settlements).toBe(1);
		expect(child.killSignals).toEqual(["SIGKILL"]);
		expect(child.listeners.get("error") ?? []).toHaveLength(0);
		expect(child.listeners.get("exit") ?? []).toHaveLength(0);
		expect(child.stdout.listenerCount("data")).toBe(0);
		expect(child.stderr.listenerCount("data")).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("settles an active child error once and gates reuse on confirmed retirement", async () => {
		vi.useFakeTimers();
		const first = new FakeChild({ autoReady: false, autoRun: false, remainAliveOnSigkill: true });
		const second = new FakeChild();
		const observed: string[] = [];
		const { kernel, spawned } = await startFakeKernelSequence([first, second], "active-error-session", (message) => {
			if (message.type === "text") observed.push(message.data);
		});
		let settlements = 0;
		try {
			const pending = kernel.run({ cellId: "failed-cell", code: "pass", timeoutMs: 10_000 }).then((result) => {
				settlements += 1;
				return result;
			});
			await vi.advanceTimersByTimeAsync(25);

			expect(() => first.fail(new Error("python transport failed"))).not.toThrow();
			await expect(pending).resolves.toMatchObject({
				ok: false,
				error: { message: "Python kernel died", stack: "python transport failed" },
				durationMs: 25,
			});
			const reused = kernel.run({ cellId: "reused-cell", code: "42", timeoutMs: 10_000 });
			first.emitMessage({ type: "text", stream: "stdout", data: "late stale output\n" });
			await vi.advanceTimersByTimeAsync(499);
			expect(spawned).toEqual([first]);
			first.finish(null, "SIGKILL");

			await expect(reused).resolves.toMatchObject({ ok: true, valueRepr: "fake" });
			expect(settlements).toBe(1);
			expect(spawned).toEqual([first, second]);
			expect(first.killSignals).toEqual(["SIGKILL"]);
			expect(observed).not.toContain("late stale output\n");
			expect(first.listeners.get("error") ?? []).toHaveLength(0);
			expect(first.listeners.get("exit") ?? []).toHaveLength(0);
			expect(first.stdout.listenerCount("data")).toBe(0);
			expect(first.stderr.listenerCount("data")).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			await kernel.close();
		}
	});

	it("preserves startup error truth while recording retirement failure", async () => {
		vi.useFakeTimers();
		const first = new FakeChild();
		const stuck = new FakeChild({ autoReady: false, autoRun: false, remainAliveOnSigkill: true });
		const { kernel, spawned } = await startFakeKernelSequence([first, stuck], "startup-retirement-error-session");
		const reset = settle(kernel.reset());
		await vi.advanceTimersByTimeAsync(0);
		expect(spawned).toEqual([first, stuck]);

		expect(() => stuck.fail(new Error("replacement startup channel failed"))).not.toThrow();
		await vi.advanceTimersByTimeAsync(500);
		const resetResult = await reset;

		expect(resetResult.status).toBe("rejected");
		if (resetResult.status === "rejected") {
			expect(resetResult.reason).toMatchObject({ message: "replacement startup channel failed" });
		}
		await expect(kernel.run({ cellId: "blocked", code: "1", timeoutMs: 1_000 })).rejects.toMatchObject({
			name: "PythonKernelRetirementError",
		});
		expect(stuck.killSignals).toEqual(["SIGKILL"]);
		expect(stuck.listeners.get("error") ?? []).toHaveLength(0);
		expect(stuck.listeners.get("exit") ?? []).toHaveLength(0);
		expect(stuck.stdout.listenerCount("data")).toBe(0);
		expect(stuck.stderr.listenerCount("data")).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		stuck.finish(null, "SIGKILL");
	});

	it("preserves active error truth while recording retirement failure", async () => {
		vi.useFakeTimers();
		const stuck = new FakeChild({ autoReady: false, autoRun: false, remainAliveOnSigkill: true });
		const kernel = await startFakeKernel(stuck, "active-retirement-error-session");
		let settlements = 0;
		const pending = kernel.run({ cellId: "failed-active", code: "pass", timeoutMs: 10_000 }).then((result) => {
			settlements += 1;
			return result;
		});
		await vi.advanceTimersByTimeAsync(25);

		expect(() => stuck.fail(new Error("active channel failed"))).not.toThrow();
		await expect(pending).resolves.toMatchObject({
			ok: false,
			error: { message: "Python kernel died", stack: "active channel failed" },
			durationMs: 25,
		});
		await vi.advanceTimersByTimeAsync(500);

		expect(settlements).toBe(1);
		await expect(kernel.run({ cellId: "blocked", code: "1", timeoutMs: 1_000 })).rejects.toMatchObject({
			name: "PythonKernelRetirementError",
		});
		expect(stuck.killSignals).toEqual(["SIGKILL"]);
		expect(stuck.listeners.get("error") ?? []).toHaveLength(0);
		expect(stuck.listeners.get("exit") ?? []).toHaveLength(0);
		expect(stuck.stdout.listenerCount("data")).toBe(0);
		expect(stuck.stderr.listenerCount("data")).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		stuck.finish(null, "SIGKILL");
	});
});
