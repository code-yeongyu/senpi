import { describe, expect, it } from "vitest";
import {
	compareRecordedStart,
	readProcessStartTicks,
	type StartProbe,
} from "../../src/utils/process-start-identity.ts";

const PID = 4242;
const TICKS = "123456";
const LATER_TICKS = "129456";
const LSTART = "Tue Oct 20 10:00:00 2026";
const LATER_LSTART = "Tue Oct 20 10:01:00 2026";

/**
 * A host on two clocks (sisyphuslabs/omo-desktop-app#3968/#3969): Linux start ticks count on the boot clock, which no
 * wall-clock step moves, while a Linux `ps lstart` is derived through btime and moves with every step. macOS
 * `ps lstart` is the wall time stored at fork and does not move. So Linux must compare ticks with ticks: comparing its
 * shifted lstart would read a 10 s step as a changed supervisor. macOS compares lstart with lstart.
 */
function host(platform: NodeJS.Platform, observed: { ticks: string; lstart: string }, stepMs: number): StartProbe {
	return {
		ticks: () => (platform === "linux" ? observed.ticks : undefined),
		time: async () =>
			platform === "linux" ? new Date(Date.parse(observed.lstart) + stepMs).toString() : observed.lstart,
	};
}

// senpi#3816 review (MEDIUM 2): an NTP or VM clock step must not end a healthy host.
describe("recorded supervisor start, one clock domain per platform", () => {
	for (const platform of ["linux", "darwin"] as const) {
		for (const stepMs of [-10_000, 0, 10_000]) {
			it(`${platform}: a live supervisor stays the same across a ${stepMs} ms wall-clock step`, async () => {
				const probe = host(platform, { ticks: TICKS, lstart: LSTART }, stepMs);
				expect(await compareRecordedStart(PID, { ticks: TICKS, time: LSTART }, platform, probe)).toBe("same");
			});

			it(`${platform}: a pid reused a minute later reads as changed across a ${stepMs} ms step`, async () => {
				const probe = host(platform, { ticks: LATER_TICKS, lstart: LATER_LSTART }, stepMs);
				expect(await compareRecordedStart(PID, { ticks: TICKS, time: LSTART }, platform, probe)).toBe("changed");
			});
		}
	}

	it("linux: a record without start ticks is unknown and never falls back to wall time", async () => {
		const probe = host("linux", { ticks: TICKS, lstart: LSTART }, 0);
		expect(await compareRecordedStart(PID, { time: LSTART }, "linux", probe)).toBe("unknown");
	});

	it("an unreadable observed start is unknown, never changed", async () => {
		const unreadable: StartProbe = { ticks: () => undefined, time: async () => undefined };
		for (const platform of ["linux", "darwin"] as const)
			expect(await compareRecordedStart(PID, { ticks: TICKS, time: LSTART }, platform, unreadable)).toBe("unknown");
	});
});

describe.skipIf(process.platform !== "linux")("/proc start ticks", () => {
	it("reads a live process's start ticks without spawning, stable across reads", () => {
		const ticks = readProcessStartTicks(process.pid);
		expect(ticks).toMatch(/^\d+$/);
		expect(readProcessStartTicks(process.pid)).toBe(ticks);
	});

	it("reports an absent process as unknown", () => {
		expect(readProcessStartTicks(2 ** 30)).toBeUndefined();
	});
});

it("reads no ticks off Linux", () => {
	expect(readProcessStartTicks(process.pid, "darwin")).toBeUndefined();
});
