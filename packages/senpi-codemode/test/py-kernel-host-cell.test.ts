import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostCellExecutor } from "../src/tool/types.ts";
import { FakeChild, hasPython3, liveKernel, startFakeKernel } from "./py-kernel/fixtures.ts";

type Gate = { readonly started: Promise<AbortSignal>; release(outcome?: { ok: true; valueRepr: string }): void };

function gatedHost(): { readonly host: HostCellExecutor; readonly gate: Gate } {
	const started = Promise.withResolvers<AbortSignal>();
	const finished = Promise.withResolvers<{ ok: true; valueRepr: string }>();
	const host: HostCellExecutor = ({ signal }) => {
		started.resolve(signal);
		// Like a real installer, the executor stops when it is aborted.
		signal.addEventListener("abort", () => finished.reject(signal.reason ?? new Error("aborted")), { once: true });
		return finished.promise;
	};
	return {
		host,
		gate: {
			started: started.promise,
			release: (outcome = { ok: true, valueRepr: "installed" }) => finished.resolve(outcome),
		},
	};
}

describe("Given a host-executed entry in the Python kernel's queue", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("When it reaches the front, then it runs on the host in FIFO order and the interpreter receives no run frame for it", async () => {
		const child = new FakeChild({ autoRun: false });
		const kernel = await startFakeKernel(child, "host-fifo");
		const { host, gate } = gatedHost();
		const active = kernel.run({ cellId: "active", code: "1", timeoutMs: 60_000 });
		const install = kernel.run({ cellId: "install", code: "%pip install x", timeoutMs: 60_000, host });
		const after = kernel.run({ cellId: "after", code: "2", timeoutMs: 60_000 });
		await vi.waitFor(() => expect(child.runMessages.map((frame) => frame.cellId)).toEqual(["active"]));

		child.emitMessage({ type: "result", cellId: "active", ok: true, valueRepr: "1", durationMs: 1 });
		await gate.started;
		expect(kernel.queueSnapshot()).toEqual({ activeCellId: "install", queuedCellIds: ["after"] });
		gate.release();

		await expect(install).resolves.toMatchObject({ cellId: "install", ok: true, valueRepr: "installed" });
		await vi.waitFor(() => expect(child.runMessages.map((frame) => frame.cellId)).toEqual(["active", "after"]));
		child.emitMessage({ type: "result", cellId: "after", ok: true, valueRepr: "2", durationMs: 1 });
		await expect(active).resolves.toMatchObject({ ok: true });
		await expect(after).resolves.toMatchObject({ ok: true });
		await kernel.close();
	});

	it("When it is cancelled while queued, then it is removed like any queued cell and its executor never runs", async () => {
		const child = new FakeChild({ autoRun: false });
		const kernel = await startFakeKernel(child, "host-queued-cancel");
		const executor = vi.fn<HostCellExecutor>(async () => ({ ok: true }));
		const active = kernel.run({ cellId: "active", code: "1", timeoutMs: 60_000 });
		const install = kernel.run({ cellId: "install", code: "%pip install x", timeoutMs: 60_000, host: executor });
		await vi.waitFor(() => expect(child.runMessages).toHaveLength(1));

		expect(kernel.cancelQueued("install", "stopped by user")).toBe(true);
		child.emitMessage({ type: "result", cellId: "active", ok: true, valueRepr: "1", durationMs: 1 });

		await expect(install).resolves.toMatchObject({ ok: false, error: { message: "stopped by user" } });
		await expect(active).resolves.toMatchObject({ ok: true });
		expect(executor).not.toHaveBeenCalled();
		await kernel.close();
	});

	it("When the active entry is interrupted, then its executor is aborted, the cell settles interrupted and the interpreter is not signalled", async () => {
		const child = new FakeChild({ autoRun: false });
		const kernel = await startFakeKernel(child, "host-interrupt");
		const { host, gate } = gatedHost();
		const install = kernel.run({ cellId: "install", code: "%pip install x", timeoutMs: 60_000, host });
		const signal = await gate.started;

		const handle = await kernel.interrupt("stopped by user", "install");

		expect(signal.aborted).toBe(true);
		await expect(handle.stateRetained).resolves.toBe(true);
		await expect(install).resolves.toMatchObject({
			ok: false,
			error: { message: "Eval interrupted: stopped by user" },
		});
		expect(child.killSignals).toEqual([]);
		gate.release();
		const next = kernel.run({ cellId: "next", code: "3", timeoutMs: 60_000 });
		await vi.waitFor(() => expect(child.runMessages.map((frame) => frame.cellId)).toEqual(["next"]));
		child.emitMessage({ type: "result", cellId: "next", ok: true, valueRepr: "3", durationMs: 1 });
		await expect(next).resolves.toMatchObject({ ok: true });
		await kernel.close();
	});

	it("When an interrupted entry's executor finishes afterwards, then its late outcome is ignored and later cells are unaffected", async () => {
		const child = new FakeChild({ autoRun: false });
		const outcomes: string[] = [];
		const kernel = await startFakeKernel(child, "host-late");
		const { host, gate } = gatedHost();
		const install = kernel.run({
			cellId: "install",
			code: "%pip install x",
			timeoutMs: 60_000,
			host,
			onMessage: (message) => {
				if (message.type === "result") outcomes.push(message.cellId);
			},
		});
		await gate.started;
		await kernel.interrupt("stopped by user", "install");
		const next = kernel.run({ cellId: "next", code: "4", timeoutMs: 60_000 });
		await vi.waitFor(() => expect(child.runMessages.map((frame) => frame.cellId)).toEqual(["next"]));

		gate.release({ ok: true, valueRepr: "late install result" });
		await Promise.resolve();

		await expect(install).resolves.toMatchObject({
			ok: false,
			error: { message: "Eval interrupted: stopped by user" },
		});
		expect(kernel.queueSnapshot()).toEqual({ activeCellId: "next", queuedCellIds: [] });
		child.emitMessage({ type: "result", cellId: "next", ok: true, valueRepr: "4", durationMs: 1 });
		await expect(next).resolves.toMatchObject({ ok: true, valueRepr: "4" });
		expect(outcomes).toEqual([]);
		await kernel.close();
	});

	it("When the active entry times out, then its executor is aborted and the interpreter is not retired", async () => {
		vi.useFakeTimers();
		const child = new FakeChild({ autoRun: false });
		const kernel = await startFakeKernel(child, "host-timeout");
		const { host, gate } = gatedHost();
		const install = kernel.run({ cellId: "install", code: "%pip install x", timeoutMs: 1_000, host });
		const signal = await gate.started;

		await vi.advanceTimersByTimeAsync(1_000);

		expect(signal.aborted).toBe(true);
		await expect(install).resolves.toMatchObject({
			ok: false,
			error: { message: "Python kernel timed out after 1000ms" },
		});
		expect(child.killSignals).toEqual([]);
		expect(kernel.isAlive()).toBe(true);
		await kernel.close();
	});

	it("When its executor rejects, then the cell fails with that message and the next queued cell still runs", async () => {
		const child = new FakeChild();
		const kernel = await startFakeKernel(child, "host-reject");
		const failing: HostCellExecutor = async () => {
			throw new Error("environment_install_failed: no matching distribution");
		};

		const install = kernel.run({ cellId: "install", code: "%pip install x", timeoutMs: 60_000, host: failing });
		const next = kernel.run({ cellId: "next", code: "1", timeoutMs: 60_000 });

		await expect(install).resolves.toMatchObject({
			ok: false,
			error: { message: "environment_install_failed: no matching distribution" },
		});
		await expect(next).resolves.toMatchObject({ ok: true });
		await kernel.close();
	});

	it("When the kernel closes with an entry active, then its executor is aborted", async () => {
		const child = new FakeChild({ autoRun: false });
		const kernel = await startFakeKernel(child, "host-close");
		const { host, gate } = gatedHost();
		const install = kernel.run({ cellId: "install", code: "%pip install x", timeoutMs: 60_000, host });
		const signal = await gate.started;

		await kernel.close();

		expect(signal.aborted).toBe(true);
		await expect(install).resolves.toMatchObject({ ok: false, error: { message: "Python kernel closed" } });
	});
});

describe.skipIf(!(await hasPython3()))("Given a live Python interpreter", () => {
	it("When a host entry is interrupted mid-run, then the interpreter keeps its pid and globals", async () => {
		const kernel = await liveKernel();
		try {
			const before = await kernel.run({
				cellId: "set",
				code: "import os; sentinel = object(); (os.getpid(), id(sentinel))",
				timeoutMs: 15_000,
			});
			const { host, gate } = gatedHost();
			const install = kernel.run({ cellId: "install", code: "%pip install x", timeoutMs: 60_000, host });
			await gate.started;

			await kernel.interrupt("stopped by user", "install");
			await install;
			const after = await kernel.run({
				cellId: "get",
				code: "import os; (os.getpid(), id(sentinel))",
				timeoutMs: 15_000,
			});

			expect(before).toMatchObject({ ok: true });
			expect(after).toMatchObject({ ok: true, valueRepr: before.ok ? before.valueRepr : "unreachable" });
		} finally {
			await kernel.close();
		}
	});
});

describe("Given an aborted host entry in the Python kernel's queue", () => {
	it("When an interrupted executor keeps running after the abort, then the next entry waits until it stops", async () => {
		const child = new FakeChild({ autoRun: false });
		const kernel = await startFakeKernel(child, "host-no-overlap");
		const events: string[] = [];
		const finished = Promise.withResolvers<{ ok: false; error: { message: string } }>();
		const started = Promise.withResolvers<void>();
		const host: HostCellExecutor = () => {
			started.resolve();
			return finished.promise;
		};
		const install = kernel.run({ cellId: "install", code: "%pip install x", timeoutMs: 60_000, host });
		const next = kernel.run({ cellId: "next", code: "2", timeoutMs: 60_000 });
		await started.promise;

		await kernel.interrupt("stopped by user", "install");
		await new Promise((resolve) => setImmediate(resolve));
		events.push(`run frames while host work runs: ${child.runMessages.length}`);
		finished.resolve({ ok: false, error: { message: "pip stopped" } });
		await expect(install).resolves.toMatchObject({
			ok: false,
			error: { message: "Eval interrupted: stopped by user" },
		});
		await vi.waitFor(() => expect(child.runMessages.map((frame) => frame.cellId)).toEqual(["next"]));
		child.emitMessage({ type: "result", cellId: "next", ok: true, valueRepr: "2", durationMs: 1 });

		expect(events).toEqual(["run frames while host work runs: 0"]);
		await expect(next).resolves.toMatchObject({ ok: true });
		await kernel.close();
	});

	it("When the executor finishes successfully as the interrupt arrives, then the cell reports that its work committed", async () => {
		const child = new FakeChild({ autoRun: false });
		const kernel = await startFakeKernel(child, "host-committed");
		const finished = Promise.withResolvers<{ ok: true; valueRepr: string }>();
		const started = Promise.withResolvers<void>();
		const host: HostCellExecutor = () => {
			started.resolve();
			return finished.promise;
		};
		const install = kernel.run({ cellId: "install", code: "%pip install x", timeoutMs: 60_000, host });
		await started.promise;

		finished.resolve({ ok: true, valueRepr: "installed" });
		await kernel.interrupt("stopped by user", "install");

		await expect(install).resolves.toMatchObject({ ok: true, valueRepr: "installed" });
		await kernel.close();
	});

	it("When the executor throws synchronously, then only its cell fails and the next queued cell still runs", async () => {
		const child = new FakeChild({ autoRun: false });
		const kernel = await startFakeKernel(child, "host-sync-throw");
		const host: HostCellExecutor = () => {
			throw new Error("sync boom");
		};
		const install = kernel.run({ cellId: "install", code: "%pip install x", timeoutMs: 60_000, host });
		const next = kernel.run({ cellId: "next", code: "2", timeoutMs: 60_000 });

		await expect(install).resolves.toMatchObject({ ok: false, error: { message: "sync boom" } });
		await vi.waitFor(() => expect(child.runMessages.map((frame) => frame.cellId)).toEqual(["next"]));
		child.emitMessage({ type: "result", cellId: "next", ok: true, valueRepr: "2", durationMs: 1 });
		await expect(next).resolves.toMatchObject({ ok: true });
		await kernel.close();
	});

	it("When an aborted executor still emits output, then that output reaches no cell", async () => {
		const child = new FakeChild({ autoRun: false });
		const seen: string[] = [];
		const kernel = await startFakeKernel(child, "host-fenced-emit");
		const finished = Promise.withResolvers<{ ok: false; error: { message: string } }>();
		let emitLate = (): void => undefined;
		const started = Promise.withResolvers<void>();
		const host: HostCellExecutor = ({ emit }) => {
			emitLate = () => emit({ type: "text", stream: "stdout", data: "late output\n" });
			started.resolve();
			return finished.promise;
		};
		const install = kernel.run({
			cellId: "install",
			code: "%pip install x",
			timeoutMs: 60_000,
			host,
			onMessage: (message) => {
				if (message.type === "text") seen.push(message.data);
			},
		});
		await started.promise;

		await kernel.interrupt("stopped by user", "install");
		emitLate();
		finished.resolve({ ok: false, error: { message: "pip stopped" } });
		await install;

		expect(seen).toEqual([]);
		await kernel.close();
	});

	it("When an aborted executor never stops, then the cell still settles after the interpreter's escalation bound", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const child = new FakeChild({ autoRun: false });
		const kernel = await startFakeKernel(child, "host-bound");
		const started = Promise.withResolvers<void>();
		const host: HostCellExecutor = () => {
			started.resolve();
			return new Promise(() => undefined);
		};
		const install = kernel.run({ cellId: "install", code: "%pip install x", timeoutMs: 600_000, host });
		await started.promise;

		await kernel.interrupt("stopped by user", "install");
		await vi.advanceTimersByTimeAsync(5_000);

		await expect(install).resolves.toMatchObject({
			ok: false,
			error: { message: "Eval interrupted: stopped by user" },
		});
		vi.useRealTimers();
		await kernel.close();
	});
});
