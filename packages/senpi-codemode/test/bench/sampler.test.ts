import { describe, expect, it } from "vitest";
import { type HostSample, sampleHost, startHostSampler } from "../../scripts/bench-sampler.ts";

describe("per-block host sampling", () => {
	it("records host load and the busiest real processes", async () => {
		// Given the real host.
		// When one sample is taken.
		const sample = await sampleHost();
		// Then it carries a timestamp, the load average and, off Windows, named processes ordered by CPU.
		expect(Number.isNaN(Date.parse(sample.at))).toBe(false);
		expect(sample.loadavg).toHaveLength(3);
		if (process.platform === "win32") return;
		expect(sample.topProcesses.length).toBeGreaterThan(0);
		const cpu = sample.topProcesses.map((entry) => entry.cpuPercent);
		expect(cpu).toEqual([...cpu].sort((a, b) => b - a));
		expect(sample.topProcesses.every((entry) => entry.pid > 0 && entry.command.length > 0)).toBe(true);
	});

	it("samples at the start, on every interval and at the end, in order and never concurrently", async () => {
		// Given a sampler whose samples are counted as they are requested.
		let active = 0;
		let overlapped = false;
		let count = 0;
		const third = Promise.withResolvers<void>();
		const fake = async (): Promise<HostSample> => {
			active += 1;
			overlapped ||= active > 1;
			await Promise.resolve();
			active -= 1;
			count += 1;
			if (count === 3) third.resolve();
			return { at: new Date(count).toISOString(), loadavg: [count, 0, 0], topProcesses: [] };
		};
		const sampler = startHostSampler(fake, 1);
		// When three interval samples have been taken and the block ends.
		await third.promise;
		const samples = await sampler.stop();
		// Then the samples are ordered, include a closing sample, and none overlapped.
		expect(samples.length).toBeGreaterThanOrEqual(4);
		expect(samples.map((entry) => entry.loadavg[0])).toEqual([...samples.keys()].map((index) => index + 1));
		expect(overlapped).toBe(false);
	});
});
