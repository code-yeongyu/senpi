import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeChild, startFakeKernel } from "./py-kernel/fixtures.ts";

const interruptSignal = process.platform === "win32" ? "SIGTERM" : "SIGINT";

describe("PythonKernel interrupt outcome", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("reports retained state when the runner answers the interrupt", async () => {
		vi.useFakeTimers();
		const child = new FakeChild({ autoReady: false, autoRun: false, remainAliveOnInterrupt: true });
		const kernel = await startFakeKernel(child, "outcome-cooperative-session");
		const pending = kernel.run({ cellId: "cooperative-cell", code: "while True: pass", timeoutMs: 60_000 });
		await vi.advanceTimersByTimeAsync(0);

		const handle = await kernel.interrupt("manual stop");
		child.emitMessage({
			type: "result",
			cellId: "cooperative-cell",
			ok: false,
			error: { message: "Eval interrupted" },
			durationMs: 1,
		});
		await pending;

		await expect(handle.stateRetained).resolves.toBe(true);
		expect(child.killSignals).toEqual([interruptSignal]);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(child.killSignals).toEqual([interruptSignal]);
	});

	it("reports lost state when the unresponsive runner is killed after the escalation window", async () => {
		vi.useFakeTimers();
		const child = new FakeChild({ autoReady: false, autoRun: false, remainAliveOnInterrupt: true });
		const kernel = await startFakeKernel(child, "outcome-escalation-session");
		const pending = kernel.run({ cellId: "escalated-cell", code: "while True: pass", timeoutMs: 60_000 });
		await vi.advanceTimersByTimeAsync(0);

		const handle = await kernel.interrupt("manual stop");
		await vi.advanceTimersByTimeAsync(5_000);
		await pending;

		await expect(handle.stateRetained).resolves.toBe(false);
		expect(child.killSignals).toEqual([interruptSignal, "SIGKILL"]);
	});

	it("reports retained state when there is nothing to interrupt", async () => {
		vi.useFakeTimers();
		const child = new FakeChild({ autoReady: false, autoRun: false });
		const kernel = await startFakeKernel(child, "outcome-idle-session");

		const handle = await kernel.interrupt("manual stop");

		await expect(handle.stateRetained).resolves.toBe(true);
		expect(child.killSignals).toEqual([]);
	});

	it("reports lost state when the interrupted runner dies", async () => {
		vi.useFakeTimers();
		const child = new FakeChild({ autoReady: false, autoRun: false, remainAliveOnInterrupt: true });
		const kernel = await startFakeKernel(child, "outcome-death-session");
		const pending = kernel.run({ cellId: "dying-cell", code: "while True: pass", timeoutMs: 60_000 });
		await vi.advanceTimersByTimeAsync(0);

		const handle = await kernel.interrupt("manual stop");
		child.finish(null, interruptSignal);
		await pending;

		await expect(handle.stateRetained).resolves.toBe(false);
	});
});
