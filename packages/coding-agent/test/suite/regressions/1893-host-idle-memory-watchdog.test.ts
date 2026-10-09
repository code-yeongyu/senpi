// Regression for senpi issue #1893: a host reported `memory pressure rssMb=9787 sessions=6` over and
// over while a superseded generation beside it held gigabytes with NO session - the state nothing
// ever named, because the sampler only reported pressure, never pressure with nothing to show for it.
import { describe, expect, it } from "vitest";
import type { ProcessFootprint } from "../../../src/core/process-footprint.ts";
import { type HostMemoryReading, HostMemorySampler } from "../../../src/modes/rpc/host-memory-sampler.ts";

const MEGABYTE = 1024 * 1024;

describe("the host memory watchdog", () => {
	it("reports an empty host above the threshold once per pressure episode", () => {
		const idle: number[] = [];
		let footprintMb = 9_000;
		let sessions = 0;
		const sampler = sampleWith({
			readFootprint: () => ({ bytes: footprintMb * MEGABYTE, measure: "phys_footprint" }),
			sessions: () => sessions,
			onIdlePressure: (reading) => idle.push(reading.footprintMb),
		});

		sampler.sample();
		sampler.sample();
		expect(idle).toEqual([9_000]);

		sessions = 1;
		sampler.sample();
		sessions = 0;
		footprintMb = 9_100;
		sampler.sample();

		expect(idle).toEqual([9_000, 9_100]);
	});

	it("says nothing while the host is below the threshold or holding sessions", () => {
		const idle: number[] = [];
		let footprintMb = 100;
		let sessions = 3;
		const sampler = sampleWith({
			readFootprint: () => ({ bytes: footprintMb * MEGABYTE, measure: "phys_footprint" }),
			sessions: () => sessions,
			onIdlePressure: (reading) => idle.push(reading.footprintMb),
		});

		sampler.sample();
		footprintMb = 9_000;
		sampler.sample();
		sessions = 0;
		footprintMb = 100;
		sampler.sample();

		expect(idle).toEqual([]);
	});
});

function sampleWith(options: {
	readFootprint: () => ProcessFootprint;
	sessions: () => number;
	onIdlePressure: (reading: HostMemoryReading) => void;
}): HostMemorySampler {
	return new HostMemorySampler({
		emit: () => {},
		onPressure: () => {},
		log: () => {},
		env: { SENPI_RPC_HOST_RSS_WARN_MB: "4096" },
		...options,
	});
}
