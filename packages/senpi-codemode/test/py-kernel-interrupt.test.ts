import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeChild, type ResultMessage, startFakeKernel } from "./py-kernel/fixtures.ts";

describe("PythonKernel interrupt regressions", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("settles a crashed active run with elapsed duration", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		const child = new FakeChild({ autoReady: false, autoRun: false });
		const kernel = await startFakeKernel(child, "duration-session");
		const settlements: ResultMessage[] = [];
		const pending = kernel.run({ cellId: "crashed-cell", code: "pass", timeoutMs: 10_000 }).then((result) => {
			settlements.push(result);
			return result;
		});
		await vi.advanceTimersByTimeAsync(0);

		await vi.advanceTimersByTimeAsync(25);
		child.finish(1, null);
		const result = await pending;

		expect(result).toMatchObject({
			type: "result",
			cellId: "crashed-cell",
			ok: false,
			error: { message: "Python kernel died" },
			durationMs: 25,
		});
		child.emitMessage({ type: "result", cellId: "crashed-cell", ok: true, valueRepr: "late", durationMs: 1 });
		child.emit("exit", 1, null);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(settlements).toHaveLength(1);
		expect(child.killSignals).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("kills an unresponsive interrupted Python run after the escalation window", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(2_000);
		const child = new FakeChild({ autoReady: false, autoRun: false, remainAliveOnInterrupt: true });
		const kernel = await startFakeKernel(child, "interrupt-session");
		const settlements: ResultMessage[] = [];
		const pending = kernel
			.run({ cellId: "interrupted-cell", code: "while True: pass", timeoutMs: 60_000 })
			.then((result) => {
				settlements.push(result);
				return result;
			});
		await vi.advanceTimersByTimeAsync(0);

		await kernel.interrupt("manual stop");
		const interruptSignal = process.platform === "win32" ? "SIGTERM" : "SIGINT";
		expect(child.killSignals).toEqual([interruptSignal]);
		await vi.advanceTimersByTimeAsync(4_999);
		expect(settlements).toEqual([]);
		expect(child.killSignals).toEqual([interruptSignal]);
		await vi.advanceTimersByTimeAsync(1);
		expect(child.killSignals).toEqual([interruptSignal, "SIGKILL"]);
		const result = await pending;

		expect(result).toMatchObject({
			type: "result",
			cellId: "interrupted-cell",
			ok: false,
			error: { message: "Eval interrupted: manual stop" },
			durationMs: 5_000,
		});
		child.emitMessage({ type: "result", cellId: "interrupted-cell", ok: true, valueRepr: "late", durationMs: 1 });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(settlements).toHaveLength(1);
		expect(child.killSignals).toEqual([interruptSignal, "SIGKILL"]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not duplicate Python interruption text", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(3_000);
		const child = new FakeChild({ autoReady: false, autoRun: false });
		const kernel = await startFakeKernel(child, "dedupe-interrupt-session");
		const pending = kernel.run({ cellId: "dedupe-interrupted-cell", code: "while True: pass", timeoutMs: 60_000 });
		await vi.advanceTimersByTimeAsync(0);

		await kernel.interrupt("Eval interrupted");
		child.emitMessage({
			type: "result",
			cellId: "dedupe-interrupted-cell",
			ok: false,
			error: { message: "Eval interrupted" },
			durationMs: 1,
		});
		const result = await pending;

		expect(result).toMatchObject({
			type: "result",
			cellId: "dedupe-interrupted-cell",
			ok: false,
			error: { message: "Eval interrupted" },
		});
	});

	it("delivers an OS interrupt when the best-effort interrupt frame write fails", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(4_000);
		const child = new FakeChild({
			autoReady: false,
			autoRun: false,
			remainAliveOnInterrupt: true,
			throwOnInterruptFrame: true,
		});
		const kernel = await startFakeKernel(child, "interrupt-write-failure-session");
		const settlements: ResultMessage[] = [];
		const pending = kernel
			.run({ cellId: "interrupt-write-failure-cell", code: "while True: pass", timeoutMs: 60_000 })
			.then((result) => {
				settlements.push(result);
				return result;
			});
		await vi.advanceTimersByTimeAsync(0);

		const interruptError = await kernel.interrupt("manual stop").then(
			() => undefined,
			(error: unknown) => (error instanceof Error ? error : new Error(String(error))),
		);
		const interruptSignal = process.platform === "win32" ? "SIGTERM" : "SIGINT";

		expect(child.killSignals).toEqual([interruptSignal]);
		expect(interruptError).toBeUndefined();
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(25);
		child.finish(null, interruptSignal);
		const result = await pending;
		expect(result).toMatchObject({
			type: "result",
			cellId: "interrupt-write-failure-cell",
			ok: false,
			error: {
				message: "Eval interrupted: manual stop",
				stack: expect.stringContaining("interrupt frame write failed"),
			},
		});
		child.emitMessage({
			type: "result",
			cellId: "interrupt-write-failure-cell",
			ok: true,
			valueRepr: "late",
			durationMs: 1,
		});
		child.emit("exit", 1, null);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(settlements).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
