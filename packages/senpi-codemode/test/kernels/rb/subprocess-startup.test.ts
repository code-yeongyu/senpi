import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeBridgeFrame, encodeBridgeFrame, type KernelToHostMessage } from "../../../src/bridge/protocol.ts";
import { parsePsCpuTime } from "../../../src/kernels/shared/process-group-cpu.ts";
import { SubprocessKernel } from "../../../src/kernels/shared/subprocess-kernel.ts";
import { SubprocessStartupWatchdog } from "../../../src/kernels/shared/subprocess-startup.ts";

const NO_PROGRESS_MS = 30_000;
// Above every platform's pid_max: signalling this "process group" finds nothing and falls back to child.kill.
const FAKE_PID = 2 ** 30;

function stage(name: string): KernelToHostMessage {
	return { type: "status", event: { op: "kernel-startup", stage: name } } as KernelToHostMessage;
}

class SilentInterpreter extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly pid = FAKE_PID;
	answerInit = false;
	readonly stdin = {
		write: (chunk: string): boolean => {
			const decoded = decodeBridgeFrame(chunk);
			if (decoded.ok && decoded.message.type === "init" && this.answerInit) this.say({ type: "ready" });
			return true;
		},
	};

	say(message: KernelToHostMessage): void {
		this.stdout.write(encodeBridgeFrame(message));
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		queueMicrotask(() => this.emit("exit", null, signal));
		return true;
	}
}

describe("SubprocessStartupWatchdog", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("Given a runner that prints nothing but keeps using CPU when the no-progress window passes again and again then it never stalls", () => {
		let cpu = 0n;
		const onStall = vi.fn();
		const watchdog = new SubprocessStartupWatchdog(
			{ label: "Julia", noProgressMs: NO_PROGRESS_MS, readGroupCpuTime: () => (cpu += 1_000n) },
			FAKE_PID,
			onStall,
		);

		vi.advanceTimersByTime(10 * NO_PROGRESS_MS);

		expect(onStall).not.toHaveBeenCalled();
		watchdog.stop();
	});

	it("Given a runner that is silent and uses no CPU after reaching runtime-init when the window passes then it stalls once, naming that stage", () => {
		const onStall = vi.fn();
		const watchdog = new SubprocessStartupWatchdog(
			{ label: "Ruby", noProgressMs: NO_PROGRESS_MS, readGroupCpuTime: () => 500n },
			FAKE_PID,
			onStall,
		);
		watchdog.observe(stage("stdlib-imports"));
		watchdog.observe(stage("runtime-init"));

		vi.advanceTimersByTime(NO_PROGRESS_MS - 1);
		expect(onStall).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		vi.advanceTimersByTime(5 * NO_PROGRESS_MS);

		expect(onStall).toHaveBeenCalledTimes(1);
		expect(onStall.mock.calls[0]?.[0]).toContain("Ruby kernel stalled at runtime-init");
	});

	it("Given a runner whose CPU stopped moving after a burst when the next window passes then it stalls", () => {
		const readings = [100n, 200n, 300n];
		const onStall = vi.fn();
		const watchdog = new SubprocessStartupWatchdog(
			{ label: "Julia", noProgressMs: NO_PROGRESS_MS, readGroupCpuTime: () => readings.shift() ?? 300n },
			FAKE_PID,
			onStall,
		);

		vi.advanceTimersByTime(2 * NO_PROGRESS_MS);
		expect(onStall).not.toHaveBeenCalled();
		vi.advanceTimersByTime(NO_PROGRESS_MS);

		expect(onStall).toHaveBeenCalledTimes(1);
		expect(onStall.mock.calls[0]?.[0]).toContain("stalled at interpreter-launch");
		watchdog.stop();
	});

	it("Given a runner whose CPU cannot be read when it stays silent for many windows then it never stalls", () => {
		const onStall = vi.fn();
		const watchdog = new SubprocessStartupWatchdog(
			{ label: "Julia", noProgressMs: NO_PROGRESS_MS, readGroupCpuTime: () => undefined },
			FAKE_PID,
			onStall,
		);

		vi.advanceTimersByTime(20 * NO_PROGRESS_MS);

		expect(onStall).not.toHaveBeenCalled();
		watchdog.stop();
	});

	it("Given the group's CPU total drops because a member exited when the window passes then that counts as activity", () => {
		const readings = [500n, 300n];
		const onStall = vi.fn();
		const watchdog = new SubprocessStartupWatchdog(
			{ label: "Ruby", noProgressMs: NO_PROGRESS_MS, readGroupCpuTime: () => readings.shift() ?? 300n },
			FAKE_PID,
			onStall,
		);

		vi.advanceTimersByTime(NO_PROGRESS_MS);
		expect(onStall).not.toHaveBeenCalled();
		vi.advanceTimersByTime(NO_PROGRESS_MS);

		expect(onStall).toHaveBeenCalledTimes(1);
		watchdog.stop();
	});

	it("Given a stage name the watchdog does not know when it arrives then the stage reached stays the last known one", () => {
		const onStall = vi.fn();
		const watchdog = new SubprocessStartupWatchdog(
			{ label: "Ruby", noProgressMs: NO_PROGRESS_MS, readGroupCpuTime: () => 1n },
			FAKE_PID,
			onStall,
		);
		watchdog.observe(stage("stdlib-imports"));
		watchdog.observe(stage("warming-up"));

		vi.advanceTimersByTime(NO_PROGRESS_MS);

		expect(onStall.mock.calls.at(-1)?.[0]).toContain("stalled at stdlib-imports");
	});

	it("Given output lines keep arriving with no CPU reader when the window passes between them then it never stalls", () => {
		const onStall = vi.fn();
		const watchdog = new SubprocessStartupWatchdog(
			{ label: "Ruby", noProgressMs: NO_PROGRESS_MS },
			FAKE_PID,
			onStall,
		);

		for (let line = 0; line < 10; line += 1) {
			vi.advanceTimersByTime(NO_PROGRESS_MS - 1);
			watchdog.observe({ type: "text", stream: "stderr", data: "warming\n" });
		}

		expect(onStall).not.toHaveBeenCalled();
		watchdog.stop();
	});
});

describe("ps cputime parsing", () => {
	it("Given the time formats macOS ps prints when they are parsed then each becomes hundredths of a second", () => {
		expect(parsePsCpuTime("0:01.32")).toBe(132n);
		expect(parsePsCpuTime("12:00.05")).toBe(72_005n);
		expect(parsePsCpuTime("1:02:03.04")).toBe(372_304n);
	});

	it("Given text that is not a cputime when it is parsed then nothing is returned", () => {
		expect(parsePsCpuTime("-")).toBeUndefined();
		expect(parsePsCpuTime("1:2")).toBeUndefined();
	});
});

describe("SubprocessKernel startup", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("Given an interpreter stuck silent and idle in runtime-init when a cell is waiting then the cell fails with a startup error naming the stage", async () => {
		const interpreter = new SilentInterpreter();
		const kernel = new SubprocessKernel({
			command: "ruby",
			args: [],
			sessionId: "rb-stalled",
			connection: { port: 1, token: "t" },
			spawn: () => interpreter as never,
			startup: { label: "Ruby", noProgressMs: NO_PROGRESS_MS, readGroupCpuTime: () => 7n },
		});
		interpreter.say(stage("runtime-init"));
		await vi.advanceTimersByTimeAsync(0);

		const cell = kernel.run({ cellId: "waits", code: "1" });
		const settled = expect(cell).resolves.toMatchObject({ ok: false });
		await vi.advanceTimersByTimeAsync(NO_PROGRESS_MS);
		await settled;
		const result = await cell;
		if (!result.ok) expect(result.error.message).toContain("Ruby kernel stalled at runtime-init");
		await kernel.close().catch(() => undefined);
	});

	it("Given a kernel whose owner replaces dead kernels when its start stalls then it is reported dead with the stage, its interpreter is stopped, and the waiting cell is handed back unrun", async () => {
		const interpreter = new SilentInterpreter();
		const kill = vi.spyOn(interpreter, "kill");
		const deaths: string[] = [];
		const kernel = new SubprocessKernel({
			command: "ruby",
			args: [],
			sessionId: "rb-stall-death",
			connection: { port: 1, token: "t" },
			spawn: () => interpreter as never,
			onDeath: (reason) => deaths.push(reason),
			startup: { label: "Ruby", noProgressMs: NO_PROGRESS_MS, readGroupCpuTime: () => 7n },
		});
		interpreter.say(stage("host-init"));
		await vi.advanceTimersByTimeAsync(0);
		const waiting = kernel.run({ cellId: "waiting", code: "1" });

		await vi.advanceTimersByTimeAsync(NO_PROGRESS_MS);

		expect(deaths).toHaveLength(1);
		expect(deaths[0]).toContain("Ruby kernel stalled at host-init");
		expect(kernel.isAlive()).toBe(false);
		expect(kill).toHaveBeenCalled();
		const pending = kernel.drainPending();
		expect(pending.map((cell) => cell.input.cellId)).toEqual(["waiting"]);
		pending[0]?.settle({ type: "result", cellId: "waiting", ok: true, valueRepr: "replaced", durationMs: 1 });
		await expect(waiting).resolves.toMatchObject({ ok: true, valueRepr: "replaced" });
	});

	it("Given a kernel that became ready when it then stays silent and idle then no stall ever fires", async () => {
		const interpreter = new SilentInterpreter();
		interpreter.answerInit = true;
		const deaths: string[] = [];
		const kernel = new SubprocessKernel({
			command: "ruby",
			args: [],
			sessionId: "rb-ready-idle",
			connection: { port: 1, token: "t" },
			spawn: () => interpreter as never,
			onDeath: (reason) => deaths.push(reason),
			startup: { label: "Ruby", noProgressMs: NO_PROGRESS_MS, readGroupCpuTime: () => 7n },
		});
		interpreter.say({ type: "ready" });
		await vi.advanceTimersByTimeAsync(0);

		await vi.advanceTimersByTimeAsync(10 * NO_PROGRESS_MS);

		expect(deaths).toEqual([]);
		expect(kernel.isAlive()).toBe(true);
		await kernel.close().catch(() => undefined);
	});

	it("Given an interpreter that exits before ready when the window later passes then only the exit is reported and its CPU is no longer read", async () => {
		const interpreter = new SilentInterpreter();
		const deaths: string[] = [];
		const readCpu = vi.fn(() => 7n);
		const kernel = new SubprocessKernel({
			command: "julia",
			args: [],
			sessionId: "jl-exit-before-ready",
			connection: { port: 1, token: "t" },
			spawn: () => interpreter as never,
			onDeath: (reason) => deaths.push(reason),
			startup: { label: "Julia", noProgressMs: NO_PROGRESS_MS, readGroupCpuTime: readCpu },
		});

		interpreter.emit("exit", 1, null);
		const readsAtExit = readCpu.mock.calls.length;
		await vi.advanceTimersByTimeAsync(5 * NO_PROGRESS_MS);

		expect(deaths).toEqual(["exit code 1"]);
		expect(readCpu.mock.calls.length).toBe(readsAtExit);
		await kernel.close().catch(() => undefined);
	});

	it("Given a kernel closed during its start when the window later passes then no stall fires and its CPU is no longer read", async () => {
		const interpreter = new SilentInterpreter();
		const deaths: string[] = [];
		const readCpu = vi.fn(() => 7n);
		const kernel = new SubprocessKernel({
			command: "ruby",
			args: [],
			sessionId: "rb-closed-starting",
			connection: { port: 1, token: "t" },
			spawn: () => interpreter as never,
			onDeath: (reason) => deaths.push(reason),
			startup: { label: "Ruby", noProgressMs: NO_PROGRESS_MS, readGroupCpuTime: readCpu },
		});

		const closing = kernel.close().catch(() => undefined);
		const readsAtClose = readCpu.mock.calls.length;
		await vi.advanceTimersByTimeAsync(5 * NO_PROGRESS_MS);
		await closing;

		expect(deaths).toEqual([]);
		expect(readCpu.mock.calls.length).toBe(readsAtClose);
	});

	it("Given a starting interpreter that ignores the kill when the kernel is closed then its CPU is no longer read and no stall fires", async () => {
		const interpreter = new SilentInterpreter();
		interpreter.kill = () => true;
		const deaths: string[] = [];
		const readCpu = vi.fn(() => 7n);
		const kernel = new SubprocessKernel({
			command: "ruby",
			args: [],
			sessionId: "rb-unkillable-starting",
			connection: { port: 1, token: "t" },
			spawn: () => interpreter as never,
			onDeath: (reason) => deaths.push(reason),
			startup: { label: "Ruby", noProgressMs: NO_PROGRESS_MS, readGroupCpuTime: readCpu },
		});

		const closing = kernel.close().catch(() => undefined);
		const readsAtClose = readCpu.mock.calls.length;
		await vi.advanceTimersByTimeAsync(5 * NO_PROGRESS_MS);
		await closing;

		expect(deaths).toEqual([]);
		expect(readCpu.mock.calls.length).toBe(readsAtClose);
	});

	it("Given startup stage frames and stderr before ready when a stall fires then cells never see the frames and the error carries the stderr tail", async () => {
		const interpreter = new SilentInterpreter();
		const seen: string[] = [];
		const kernel = new SubprocessKernel({
			command: "ruby",
			args: [],
			sessionId: "rb-frames",
			connection: { port: 1, token: "t" },
			spawn: () => interpreter as never,
			onMessage: (message) => seen.push(message.type === "status" ? `status:${message.event.op}` : message.type),
			startup: { label: "Ruby", noProgressMs: NO_PROGRESS_MS, readGroupCpuTime: () => 7n },
		});
		interpreter.say(stage("stdlib-imports"));
		interpreter.say({ type: "text", stream: "stderr", data: "cannot load such file -- json\n" });
		await vi.advanceTimersByTimeAsync(0);
		const cell = kernel.run({ cellId: "waits", code: "1" });

		await vi.advanceTimersByTimeAsync(NO_PROGRESS_MS);
		const result = await cell;

		expect(seen).not.toContain("status:kernel-startup");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("cannot load such file -- json");
		await kernel.close().catch(() => undefined);
	});

	it("Given an interpreter that becomes ready after a long silent but CPU-busy start when a cell runs then it runs normally", async () => {
		const interpreter = new SilentInterpreter();
		let cpu = 0n;
		const kernel = new SubprocessKernel({
			command: "julia",
			args: [],
			sessionId: "jl-slow",
			connection: { port: 1, token: "t" },
			spawn: () => interpreter as never,
			startup: { label: "Julia", noProgressMs: NO_PROGRESS_MS, readGroupCpuTime: () => (cpu += 10n) },
		});
		await vi.advanceTimersByTimeAsync(5 * NO_PROGRESS_MS);

		interpreter.answerInit = true;
		interpreter.say({ type: "ready" });
		await vi.advanceTimersByTimeAsync(0);
		const cell = kernel.run({ cellId: "after-slow-start", code: "1" });
		await vi.advanceTimersByTimeAsync(0);
		interpreter.say({ type: "result", cellId: "after-slow-start", ok: true, valueRepr: "1", durationMs: 1 });

		await expect(cell).resolves.toMatchObject({ ok: true });
		await kernel.close().catch(() => undefined);
	});
});
