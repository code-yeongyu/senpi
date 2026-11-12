import { afterEach, beforeEach, expect, it, vi } from "vitest";

// senpi#3152 / senpi#4301: the boot instant was `now - os.uptime()` rounded, and os.uptime() counts whole seconds, so
// two reads straddling an uptime tick computed instants a second apart. It is read from the kernel's boot record now:
// `btime` in /proc/stat on Linux, `kern.boottime` from sysctl on macOS. Both sources are mocked and the platform is
// passed in, so every case runs on every host.
const kernel = vi.hoisted(() => ({ uptimeSeconds: 4_000, btime: 1_000, sysctlCalls: 0, sysctlThrowsOnce: false }));
vi.mock("node:os", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:os")>()),
	uptime: () => kernel.uptimeSeconds,
}));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: ((path: unknown, ...rest: unknown[]) =>
			path === "/proc/stat"
				? `cpu 1 2 3\nbtime ${kernel.btime}\nprocesses 1\n`
				: Reflect.apply(actual.readFileSync, actual, [path, ...rest])) as typeof actual.readFileSync,
	};
});
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFileSync: ((file: unknown, ...rest: unknown[]) => {
			if (file !== "/usr/sbin/sysctl") return Reflect.apply(actual.execFileSync, actual, [file, ...rest]);
			kernel.sysctlCalls++;
			if (kernel.sysctlThrowsOnce) {
				kernel.sysctlThrowsOnce = false;
				throw new Error("sysctl: unavailable");
			}
			return `{ sec = ${kernel.btime}, usec = 123456 } Thu Jan  1 00:16:40 1970\n`;
		}) as typeof actual.execFileSync,
	};
});

// Each case imports a fresh copy of the module, so the per-process memo of the kernel record starts empty.
async function freshProcessBootAtMs(): Promise<
	typeof import("../../../src/core/extensions/builtin/terminal/process-identity.ts").processBootAtMs
> {
	vi.resetModules();
	return (await import("../../../src/core/extensions/builtin/terminal/process-identity.ts")).processBootAtMs;
}

beforeEach(() => {
	kernel.btime = 1_000;
	kernel.sysctlCalls = 0;
	kernel.sysctlThrowsOnce = false;
});

afterEach(() => {
	vi.useRealTimers();
});

for (const platform of ["linux", "darwin"] as const) {
	it(`reads the same boot instant on both sides of an uptime tick (${platform})`, async () => {
		const processBootAtMs = await freshProcessBootAtMs();
		// Booted at 1_000.4 s: at 5_000.9 s uptime still reads 4_000, at 5_001.4 s it has ticked to 4_001.
		vi.useFakeTimers({ toFake: ["Date"], now: 5_000_900 });
		kernel.uptimeSeconds = 4_000;
		const first = processBootAtMs(Date.now, platform);
		vi.setSystemTime(5_001_400);
		kernel.uptimeSeconds = 4_001;
		expect(processBootAtMs(Date.now, platform)).toBe(first);
	});

	it(`gives two readers the same moved instant after a wall-clock step (${platform})`, async () => {
		// A wall-clock step of +300 s moves the kernel's recorded boot time; two processes that start afterwards (two
		// fresh module copies here) read the same moved instant.
		kernel.btime = 1_300;
		const readerA = (await freshProcessBootAtMs())(Date.now, platform);
		const readerB = (await freshProcessBootAtMs())(Date.now, platform);
		expect({ readerA, readerB }).toEqual({ readerA: 1_300_000, readerB: 1_300_000 });
	});
}

it("reads the darwin boot record with one sysctl call however often it is asked", async () => {
	const processBootAtMs = await freshProcessBootAtMs();
	processBootAtMs(Date.now, "darwin");
	processBootAtMs(Date.now, "darwin");
	expect(kernel.sysctlCalls).toBe(1);
});

it("retries a kernel read that failed instead of remembering the failure", async () => {
	const processBootAtMs = await freshProcessBootAtMs();
	kernel.sysctlThrowsOnce = true;
	kernel.uptimeSeconds = 4_000;
	vi.useFakeTimers({ toFake: ["Date"], now: 5_000_900 });

	// The first read falls back to now - uptime; only a value the kernel returned is remembered, so the second reads it.
	const fallback = processBootAtMs(Date.now, "darwin");
	const fromKernel = processBootAtMs(Date.now, "darwin");

	expect({ fallback, fromKernel, calls: kernel.sysctlCalls }).toEqual({
		fallback: 1_001_000,
		fromKernel: 1_000_000,
		calls: 2,
	});
});
