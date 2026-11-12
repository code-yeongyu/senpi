import { afterEach, expect, it, vi } from "vitest";

// senpi#3152 / senpi#4301: the boot instant was `now - os.uptime()` rounded, and os.uptime() counts whole seconds, so
// two reads straddling an uptime tick computed instants a second apart. It is read from the kernel's boot record now.
const clock = vi.hoisted(() => ({ uptimeSeconds: 4_000, btime: 1_000 }));
vi.mock("node:os", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:os")>()),
	uptime: () => clock.uptimeSeconds,
}));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: ((path: unknown, ...rest: unknown[]) =>
			path === "/proc/stat"
				? `cpu 1 2 3\nbtime ${clock.btime}\nprocesses 1\n`
				: Reflect.apply(actual.readFileSync, actual, [path, ...rest])) as typeof actual.readFileSync,
	};
});

const { processBootAtMs } = await import("../../../src/core/extensions/builtin/terminal/process-identity.ts");

afterEach(() => {
	vi.useRealTimers();
});

it.runIf(process.platform === "linux")("reads the same boot instant on both sides of an uptime tick", () => {
	// Booted at 1_000.4 s: at 5_000.9 s uptime still reads 4_000, at 5_001.4 s it has ticked to 4_001.
	vi.useFakeTimers({ toFake: ["Date"], now: 5_000_900 });
	clock.uptimeSeconds = 4_000;
	const first = processBootAtMs();
	vi.setSystemTime(5_001_400);
	clock.uptimeSeconds = 4_001;
	expect(processBootAtMs()).toBe(first);
});

it.runIf(process.platform === "linux")(
	"moves the boot instant alike for every reader when the wall clock steps",
	() => {
		clock.btime = 1_000;
		const before = processBootAtMs();
		// A wall-clock step of +300 s: the kernel moves its recorded boot time, and every later read sees the same move.
		clock.btime = 1_300;
		const readerA = processBootAtMs();
		const readerB = processBootAtMs();
		expect({ readerA, readerB, moved: readerA - before }).toEqual({
			readerA: 1_300_000,
			readerB: 1_300_000,
			moved: 300_000,
		});
	},
);
