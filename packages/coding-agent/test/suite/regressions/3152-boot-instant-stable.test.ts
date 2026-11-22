import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// senpi#3152 / senpi#4301: the boot instant was `now - os.uptime()` rounded, and os.uptime() counts whole seconds, so
// two reads straddling an uptime tick computed instants a second apart. It is read from the kernel's boot record now:
// `btime` in /proc/stat on Linux, `kern.boottime` from sysctl on macOS. Both sources are mocked and the platform is
// passed in, so every case runs on every host.
const kernel = {
	uptimeSeconds: 4_000,
	btime: 1_000,
	sysctlCalls: 0,
	procStatReads: 0,
	sysctlThrowsOnce: false,
};

// Each case imports a fresh copy of the module, so the per-process memo of the kernel record starts empty.
async function freshProcessBootAtMs(): Promise<
	typeof import("../../../src/core/extensions/builtin/terminal/process-identity.ts").processBootAtMs
> {
	vi.resetModules();
	return (await import("../../../src/core/extensions/builtin/terminal/process-identity.ts")).processBootAtMs;
}

beforeEach(() => {
	kernel.uptimeSeconds = 4_000;
	kernel.btime = 1_000;
	kernel.sysctlCalls = 0;
	kernel.procStatReads = 0;
	kernel.sysctlThrowsOnce = false;
	const readFile = fs.readFile;
	const execFile = childProcess.execFile;
	vi.spyOn(os, "uptime").mockImplementation(() => kernel.uptimeSeconds);
	vi.spyOn(fs, "readFile").mockImplementation(async (path, ...rest) => {
		if (path !== "/proc/stat") return Reflect.apply(readFile, fs, [path, ...rest]);
		kernel.procStatReads++;
		return `cpu 1 2 3\nbtime ${kernel.btime}\nprocesses 1\n`;
	});
	vi.spyOn(childProcess, "execFile").mockImplementation((file, ...rest) => {
		if (file !== "/usr/sbin/sysctl") return Reflect.apply(execFile, childProcess, [file, ...rest]);
		const callback = rest.at(-1);
		if (typeof callback !== "function") throw new Error("the boot read passes a callback");
		kernel.sysctlCalls++;
		if (kernel.sysctlThrowsOnce) {
			kernel.sysctlThrowsOnce = false;
			queueMicrotask(() => Reflect.apply(callback, undefined, [new Error("sysctl: unavailable"), ""]));
		} else {
			queueMicrotask(() =>
				Reflect.apply(callback, undefined, [
					null,
					`{ sec = ${kernel.btime}, usec = 123456 } Thu Jan  1 00:16:40 1970\n`,
				]),
			);
		}
		// Return a real ChildProcess-shaped handle without spawning a command.
		return new childProcess.ChildProcess();
	});
	syncBuiltinESMExports();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	syncBuiltinESMExports();
});

for (const platform of ["linux", "darwin"] as const) {
	it(`reads the same boot instant on both sides of an uptime tick (${platform})`, async () => {
		const processBootAtMs = await freshProcessBootAtMs();
		// Booted at 1_000.4 s: at 5_000.9 s uptime still reads 4_000, at 5_001.4 s it has ticked to 4_001.
		vi.useFakeTimers({ toFake: ["Date"], now: 5_000_900 });
		kernel.uptimeSeconds = 4_000;
		const first = await processBootAtMs(Date.now, platform);
		vi.setSystemTime(5_001_400);
		kernel.uptimeSeconds = 4_001;
		expect(await processBootAtMs(Date.now, platform)).toBe(first);
		expect(first).toBe(1_000_000);
	});

	it(`gives two readers the same moved instant after a wall-clock step (${platform})`, async () => {
		// A wall-clock step of +300 s moves the kernel's recorded boot time; two processes that start afterwards (two
		// fresh module copies here) read the same moved instant.
		kernel.btime = 1_300;
		const readerA = await (await freshProcessBootAtMs())(Date.now, platform);
		const readerB = await (await freshProcessBootAtMs())(Date.now, platform);
		expect({ readerA, readerB }).toEqual({ readerA: 1_300_000, readerB: 1_300_000 });
	});
}

it("reads the darwin boot record with one sysctl call however often it is asked", async () => {
	const processBootAtMs = await freshProcessBootAtMs();
	await processBootAtMs(Date.now, "darwin");
	await processBootAtMs(Date.now, "darwin");
	expect(kernel.sysctlCalls).toBe(1);
});

it("retries a kernel read that failed instead of remembering the failure", async () => {
	const processBootAtMs = await freshProcessBootAtMs();
	kernel.sysctlThrowsOnce = true;
	kernel.uptimeSeconds = 4_000;
	vi.useFakeTimers({ toFake: ["Date"], now: 5_000_900 });

	// The first read falls back to now - uptime; only a value the kernel returned is remembered, so the second reads it.
	const fallback = await processBootAtMs(Date.now, "darwin");
	const fromKernel = await processBootAtMs(Date.now, "darwin");

	expect({ fallback, fromKernel, calls: kernel.sysctlCalls }).toEqual({
		fallback: 1_001_000,
		fromKernel: 1_000_000,
		calls: 2,
	});
});

for (const platform of ["linux", "darwin"] as const) {
	it(`reads the kernel boot record once per process and does no I/O at a later call (${platform})`, async () => {
		const processBootAtMs = await freshProcessBootAtMs();
		const first = await processBootAtMs(Date.now, platform);
		const readsAfterFirst = kernel.procStatReads + kernel.sysctlCalls;

		const second = await processBootAtMs(Date.now, platform);

		expect({
			same: second === first,
			ioAtSecondCall: kernel.procStatReads + kernel.sysctlCalls - readsAfterFirst,
		}).toEqual({
			same: true,
			ioAtSecondCall: 0,
		});
	});
}

it("re-reads a stale cached boot record before calling a live peer from another boot", async ({ onTestFinished }) => {
	// ownBootAtMs reads this host's platform; pin it to linux so the mocked /proc/stat is the record on every host.
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "linux", configurable: true });
	onTestFinished(() => {
		if (platform !== undefined) Object.defineProperty(process, "platform", platform);
	});
	vi.resetModules();
	const identity = await import("../../../src/core/extensions/builtin/terminal/process-identity.ts");
	const cached = await identity.ownBootAtMs();
	// A wall-clock step of +300 s moves the kernel's recorded boot instant; a live peer that started afterwards
	// recorded the moved instant, while this process still caches the old one.
	kernel.btime += 300;

	const verdict = await identity.sameBootAsOwn(kernel.btime * 1000);

	expect({ cached, verdict, refreshed: await identity.ownBootAtMs() }).toEqual({
		cached: 1_000_000,
		verdict: true,
		refreshed: 1_300_000,
	});
});
