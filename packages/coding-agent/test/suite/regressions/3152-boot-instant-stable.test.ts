import { afterEach, expect, it, vi } from "vitest";

// senpi#3152 / senpi#4301: os.uptime() counts whole seconds, so two boot-instant reads that straddle an uptime tick
// computed boot instants a second apart. The boot instant of one process cannot change, so it is read once.
const clock = vi.hoisted(() => ({ uptimeSeconds: 4_000 }));
vi.mock("node:os", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:os")>()),
	uptime: () => clock.uptimeSeconds,
}));

const { processBootAtMs } = await import("../../../src/core/extensions/builtin/terminal/process-identity.ts");

afterEach(() => {
	vi.useRealTimers();
});

it("reads the same boot instant on both sides of an uptime tick", () => {
	// Booted at 1_000.4 s: at 5_000.9 s uptime still reads 4_000, at 5_001.4 s it has ticked to 4_001.
	vi.useFakeTimers({ toFake: ["Date"], now: 5_000_900 });
	clock.uptimeSeconds = 4_000;
	const first = processBootAtMs();
	vi.setSystemTime(5_001_400);
	clock.uptimeSeconds = 4_001;
	expect(processBootAtMs()).toBe(first);
});
