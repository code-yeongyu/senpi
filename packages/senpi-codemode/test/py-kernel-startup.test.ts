import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { PythonKernel } from "../src/kernels/py/kernel.ts";
import { FakeChild } from "./py-kernel/fixtures.ts";

// These tests give fake children pids. A kill path that bypasses the injected group kill must fail here,
// never send a real signal to whatever process group happens to have that id.
let realKill: MockInstance<typeof process.kill>;

beforeEach(() => {
	realKill = vi.spyOn(process, "kill").mockImplementation(() => {
		throw new Error("test reached the real process.kill");
	});
});

afterEach(() => {
	const reached = realKill.mock.calls.map((call) => call.slice(0, 2));
	vi.restoreAllMocks();
	vi.useRealTimers();
	// hardKill swallows a failed group kill, so the throw alone could go unnoticed: assert it never ran.
	expect(reached, "a kill path reached the real process.kill").toEqual([]);
});

describe("Python startup progress", () => {
	it("waits for ready when bootstrap stages exceed the old total deadline", async () => {
		// Given: an interpreter whose individual stages progress, but take 12 seconds in total.
		vi.useFakeTimers();
		const child = new FakeChild({ autoReady: false });
		const started = PythonKernel.start({
			interpreterPath: "python3",
			sessionId: "slow-bootstrap",
			cwd: process.cwd(),
			connection: { port: 1, token: "fixture" },
			startupTimeoutMs: 5_000,
			spawnProcess: () => child,
		});
		const outcome = started.then(
			(kernel) => ({ kernel }),
			(error: unknown) => ({ error }),
		);

		// When: each next stage arrives before the per-stage hang guard, followed by ready.
		for (const stage of ["stdlib-imports", "runtime-init", "host-init"]) {
			await vi.advanceTimersByTimeAsync(4_000);
			child.emitMessage({ type: "status", event: { op: "kernel-startup", stage } });
		}
		child.emitMessage({ type: "ready" });
		const result = await outcome;

		// Then: the actual ready event admits the kernel without killing it.
		expect("kernel" in result).toBe(true);
		expect(child.killSignals).toEqual([]);
		if ("kernel" in result) await result.kernel.close();
	});

	it("names the last stage and retires the child when that stage hangs", async () => {
		// Given: an interpreter that reaches imports but never progresses.
		vi.useFakeTimers();
		const child = new FakeChild({ autoReady: false });
		const started = PythonKernel.start({
			interpreterPath: "python3",
			sessionId: "hung-bootstrap",
			cwd: process.cwd(),
			connection: { port: 1, token: "fixture" },
			startupTimeoutMs: 200,
			spawnProcess: () => child,
		});
		const outcome = started.catch((error: unknown) => error);
		child.emitMessage({ type: "status", event: { op: "kernel-startup", stage: "stdlib-imports" } });
		child.stderr.write("import diagnostic\n");

		// When: no next-stage or ready event arrives within the hang guard.
		await vi.advanceTimersByTimeAsync(200);

		// Then: the error identifies the stalled stage, and the owned child is retired.
		const error = await outcome;
		expect(error).toMatchObject({
			stage: "stdlib-imports",
			message: expect.stringContaining("import diagnostic"),
		});
		expect(error instanceof Error && error.message).toContain("stdlib-imports");
		expect(child.killSignals).toEqual(["SIGKILL"]);
	});

	it("keeps waiting for a cold interpreter that is silent in its imports but busy on the CPU", async () => {
		// Given: a contended cold start that stays in stdlib imports far longer than the guard, using CPU throughout.
		vi.useFakeTimers();
		const child = new FakeChild({ autoReady: false });
		let cpu = 0n;
		const started = PythonKernel.start({
			interpreterPath: "python3",
			sessionId: "slow-cold-start",
			cwd: process.cwd(),
			connection: { port: 1, token: "fixture" },
			startupTimeoutMs: 200,
			startupCeilingMs: 10_000,
			readCpuTime: () => (cpu += 10n),
			spawnProcess: () => child,
		});
		let settled = false;
		started.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		child.emitMessage({ type: "status", event: { op: "kernel-startup", stage: "stdlib-imports" } });

		// When: five guard periods pass with no stage change and no output.
		await vi.advanceTimersByTimeAsync(1_000);

		// Then: it is still starting; the ready event then completes the start.
		expect(settled).toBe(false);
		child.emitMessage({ type: "ready" });
		const result = await started;
		expect(child.killSignals).toEqual([]);
		await result.close();
	});

	it("fails a silent and idle interpreter after the guard, naming the stage it stopped in", async () => {
		// Given: an interpreter that reached stdlib imports, then neither writes nor uses any CPU.
		vi.useFakeTimers();
		const child = new FakeChild({ autoReady: false });
		const started = PythonKernel.start({
			interpreterPath: "python3",
			sessionId: "idle-stall",
			cwd: process.cwd(),
			connection: { port: 1, token: "fixture" },
			startupTimeoutMs: 200,
			startupCeilingMs: 10_000,
			readCpuTime: () => 500n,
			spawnProcess: () => child,
		});
		const outcome = started.catch((error: unknown) => error);
		child.emitMessage({ type: "status", event: { op: "kernel-startup", stage: "stdlib-imports" } });

		// When: one guard period passes with nothing at all.
		await vi.advanceTimersByTimeAsync(200);

		// Then: startup fails at stdlib-imports and the child is retired.
		const error = await outcome;
		expect(error).toMatchObject({
			stage: "stdlib-imports",
			message: expect.stringContaining("no output, stage change or CPU use"),
		});
		expect(child.killSignals).toEqual(["SIGKILL"]);
	});

	it("stops an interpreter that stays busy but never becomes ready at the startup ceiling, naming its stage", async () => {
		// Given: an interpreter spinning in stdlib imports (CPU always advancing, never ready).
		vi.useFakeTimers();
		const child = new FakeChild({ autoReady: false });
		let cpu = 0n;
		const started = PythonKernel.start({
			interpreterPath: "python3",
			sessionId: "livelock",
			cwd: process.cwd(),
			connection: { port: 1, token: "fixture" },
			startupTimeoutMs: 200,
			startupCeilingMs: 2_000,
			readCpuTime: () => (cpu += 10n),
			spawnProcess: () => child,
		});
		const outcome = started.catch((error: unknown) => error);
		child.emitMessage({ type: "status", event: { op: "kernel-startup", stage: "stdlib-imports" } });

		// When: the ceiling passes.
		await vi.advanceTimersByTimeAsync(2_000);

		// Then: startup fails at stdlib-imports with the ceiling named, and the child is retired.
		const error = await outcome;
		expect(error).toMatchObject({ stage: "stdlib-imports", message: expect.stringContaining("not ready after 2 s") });
		expect(child.killSignals).toEqual(["SIGKILL"]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps a starting interpreter alive while it writes output", async () => {
		// Given: CPU cannot be read here, but the interpreter keeps printing during its imports.
		vi.useFakeTimers();
		const child = new FakeChild({ autoReady: false });
		const started = PythonKernel.start({
			interpreterPath: "python3",
			sessionId: "chatty-start",
			cwd: process.cwd(),
			connection: { port: 1, token: "fixture" },
			startupTimeoutMs: 200,
			startupCeilingMs: 10_000,
			readCpuTime: () => undefined,
			spawnProcess: () => child,
		});
		let settled = false;
		started.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		child.emitMessage({ type: "status", event: { op: "kernel-startup", stage: "stdlib-imports" } });

		// When: it writes a line every 150 ms for a second.
		for (let tick = 0; tick < 7; tick++) {
			await vi.advanceTimersByTimeAsync(150);
			child.stderr.write("warming up\n");
		}

		// Then: it is still starting, and ready completes it.
		expect(settled).toBe(false);
		child.emitMessage({ type: "ready" });
		await (await started).close();
	});

	it("keeps a starting interpreter alive while it prints on stdout", async () => {
		// Given: CPU cannot be read here, but the interpreter prints to stdout during its imports.
		vi.useFakeTimers();
		const child = new FakeChild({ autoReady: false });
		const started = PythonKernel.start({
			interpreterPath: "python3",
			sessionId: "stdout-start",
			cwd: process.cwd(),
			connection: { port: 1, token: "fixture" },
			startupTimeoutMs: 200,
			startupCeilingMs: 10_000,
			readCpuTime: () => undefined,
			spawnProcess: () => child,
		});
		let settled = false;
		started.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		child.emitMessage({ type: "status", event: { op: "kernel-startup", stage: "stdlib-imports" } });

		// When: it prints a text frame every 150 ms for a second.
		for (let tick = 0; tick < 7; tick++) {
			await vi.advanceTimersByTimeAsync(150);
			child.emitMessage({ type: "text", stream: "stdout", data: "warming up\n" });
		}

		// Then: it is still starting, and ready completes it.
		expect(settled).toBe(false);
		child.emitMessage({ type: "ready" });
		await (await started).close();
	});

	it("fails an interpreter that goes idle right after a stage change within one guard period", async () => {
		// Given: CPU time that grows with the clock until the stage frame, then stops for good.
		vi.useFakeTimers();
		const child = new FakeChild({ autoReady: false });
		let frozen: bigint | undefined;
		const started = PythonKernel.start({
			interpreterPath: "python3",
			sessionId: "idle-after-stage",
			cwd: process.cwd(),
			connection: { port: 1, token: "fixture" },
			startupTimeoutMs: 200,
			startupCeilingMs: 10_000,
			readCpuTime: () => frozen ?? BigInt(Date.now()),
			spawnProcess: () => child,
		});
		let failure: unknown;
		started.catch((error: unknown) => {
			failure = error;
		});
		await vi.advanceTimersByTimeAsync(150);
		child.emitMessage({ type: "status", event: { op: "kernel-startup", stage: "runtime-init" } });
		frozen = BigInt(Date.now());

		// When: one guard period passes after the stage change.
		await vi.advanceTimersByTimeAsync(200);

		// Then: it has already failed at runtime-init, not a period later.
		expect(failure).toMatchObject({ stage: "runtime-init" });
		expect(child.killSignals).toEqual(["SIGKILL"]);
	});

	it("retires a stalled interpreter with one SIGKILL to its process group, and never through the real process table", async () => {
		// Given: a child with a pid, its group kill observed through the injected function.
		vi.useFakeTimers();
		const child = Object.assign(new FakeChild({ autoReady: false }), { pid: 4246 });
		const groupKills: [number, NodeJS.Signals][] = [];
		const started = PythonKernel.start({
			interpreterPath: "python3",
			sessionId: "group-kill",
			cwd: process.cwd(),
			connection: { port: 1, token: "fixture" },
			startupTimeoutMs: 200,
			startupCeilingMs: 10_000,
			readCpuTime: () => 1n,
			killProcessGroup: (pid, signal) => {
				groupKills.push([pid, signal]);
				child.kill(signal);
			},
			spawnProcess: () => child,
		});
		const outcome = started.catch((error: unknown) => error);

		// When: it stalls for one guard period.
		await vi.advanceTimersByTimeAsync(200);

		// Then: startup fails and the group gets exactly one SIGKILL (Windows has no groups: the child is killed).
		expect(await outcome).toMatchObject({ stage: "interpreter-launch" });
		expect(groupKills).toEqual(process.platform === "win32" ? [] : [[4246, "SIGKILL"]]);
		expect(child.killSignals).toEqual(["SIGKILL"]);
	});

	it("falls back to killing the child itself when its process group is already gone", async () => {
		// Given: a group kill that reports the group is gone (ESRCH).
		vi.useFakeTimers();
		const child = Object.assign(new FakeChild({ autoReady: false }), { pid: 4247 });
		let groupKillAttempts = 0;
		const started = PythonKernel.start({
			interpreterPath: "python3",
			sessionId: "group-gone",
			cwd: process.cwd(),
			connection: { port: 1, token: "fixture" },
			startupTimeoutMs: 200,
			startupCeilingMs: 10_000,
			readCpuTime: () => 1n,
			killProcessGroup: () => {
				groupKillAttempts += 1;
				throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
			},
			spawnProcess: () => child,
		});
		const outcome = started.catch((error: unknown) => error);

		// When: it stalls for one guard period.
		await vi.advanceTimersByTimeAsync(200);

		// Then: the child itself receives the SIGKILL.
		expect(await outcome).toMatchObject({ stage: "interpreter-launch" });
		expect(groupKillAttempts).toBe(process.platform === "win32" ? 0 : 1);
		expect(child.killSignals).toEqual(["SIGKILL"]);
	});

	it("does not extend a hung stage for repeated progress frames", async () => {
		// Given: an interpreter stuck in imports.
		vi.useFakeTimers();
		const child = new FakeChild({ autoReady: false });
		const started = PythonKernel.start({
			interpreterPath: "python3",
			sessionId: "repeated-stage",
			cwd: process.cwd(),
			connection: { port: 1, token: "fixture" },
			startupTimeoutMs: 200,
			spawnProcess: () => child,
		});
		const outcome = started.catch((error: unknown) => error);
		child.emitMessage({ type: "status", event: { op: "kernel-startup", stage: "stdlib-imports" } });

		// When: repeated and unknown stages arrive instead of an advancing stage.
		await vi.advanceTimersByTimeAsync(150);
		child.emitMessage({ type: "status", event: { op: "kernel-startup", stage: "stdlib-imports" } });
		child.emitMessage({ type: "status", event: { op: "kernel-startup", stage: "unknown" } });
		await vi.advanceTimersByTimeAsync(50);

		// Then: these frames cannot keep the child alive indefinitely.
		expect(await outcome).toMatchObject({ stage: "stdlib-imports" });
		expect(child.killSignals).toEqual(["SIGKILL"]);
		expect(vi.getTimerCount()).toBe(0);
	});
});
