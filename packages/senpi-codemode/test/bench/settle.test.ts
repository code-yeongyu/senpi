import { describe, expect, it } from "vitest";
import { waitForLoadBelow } from "../../scripts/bench-settle.ts";

describe("waitForLoadBelow (senpi#2909)", () => {
	it("waits while a decaying 1-minute load is over the ceiling", async () => {
		// Given a load that decays from a spike the way the 1-minute average does.
		const readings = [100, 92, 84, 77, 69, 60];
		const slept: number[] = [];
		// When waiting for 70 or less.
		const settled = await waitForLoadBelow(70, {
			read: () => readings.shift() ?? 0,
			sleep: async (ms) => {
				slept.push(ms);
			},
			intervalMs: 5_000,
		});
		// Then it slept until the fifth reading and reports success.
		expect(settled).toBe(true);
		expect(slept).toEqual([5_000, 5_000, 5_000, 5_000]);
	});

	it("gives up after its timeout and says so", async () => {
		const lines: string[] = [];
		const settled = await waitForLoadBelow(70, {
			read: () => 90,
			sleep: async () => {},
			intervalMs: 5_000,
			timeoutMs: 15_000,
			log: (line) => lines.push(line),
		});
		expect(settled).toBe(false);
		expect(lines).toEqual(["host load 90.00 still over 70 after 15 s; retrying anyway"]);
	});
});
