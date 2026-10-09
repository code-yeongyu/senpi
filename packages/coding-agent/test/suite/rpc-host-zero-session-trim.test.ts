import { describe, expect, it } from "vitest";
import { ZERO_SESSION_TRIM_MIN_INTERVAL_MS, ZeroSessionTrimmer } from "../../src/modes/rpc/host-zero-session-trim.ts";
import type { RpcHostTrimmedEvent } from "../../src/modes/rpc/rpc-types.ts";

const MEGABYTE = 1024 * 1024;

function createTrimmer(options: { collect?: () => boolean } = {}) {
	let clock = 0;
	let sessions = 0;
	let footprintMb = 500;
	const records: RpcHostTrimmedEvent[] = [];
	let collections = 0;
	const trimmer = new ZeroSessionTrimmer({
		emit: (record) => records.push(record),
		sessions: () => sessions,
		now: () => clock,
		readFootprint: () => ({ bytes: footprintMb * MEGABYTE, measure: "phys_footprint" }),
		collect:
			options.collect ??
			(() => {
				collections += 1;
				footprintMb = 120;
				return true;
			}),
	});
	return {
		records,
		trimmer,
		collections: () => collections,
		setSessions: (count: number) => {
			sessions = count;
			trimmer.check();
		},
		/** The next tick, which reports a collection the previous one ran. */
		tick: () => trimmer.check(),
		advance: (ms: number) => {
			clock += ms;
		},
		allocate: (mb: number) => {
			footprintMb = mb;
		},
	};
}

describe("zero-session host trim", () => {
	it("collects once when the last session goes and reports the footprint before and after", () => {
		const harness = createTrimmer();
		harness.setSessions(3);
		harness.setSessions(0);
		expect(harness.records).toEqual([]);
		harness.tick();
		expect(harness.records).toEqual([
			{
				type: "host_trimmed",
				footprintBeforeMb: 500,
				footprintAfterMb: 120,
				measure: "phys_footprint",
				collected: true,
			},
		]);
		harness.tick();
		expect(harness.records).toHaveLength(1);
		expect(harness.collections()).toBe(1);
	});

	it("never trims while a session is still open", () => {
		const harness = createTrimmer();
		harness.setSessions(2);
		harness.setSessions(1);
		expect(harness.records).toEqual([]);
		expect(harness.collections()).toBe(0);
	});

	it("trims after a session that opened and closed between two observations", () => {
		const harness = createTrimmer();
		harness.trimmer.observe(1);
		harness.trimmer.observe(0);
		harness.setSessions(0);
		harness.tick();
		expect(harness.records).toHaveLength(1);
	});

	it("never trims a host that never held a session", () => {
		const harness = createTrimmer();
		harness.setSessions(0);
		harness.setSessions(0);
		expect(harness.records).toEqual([]);
	});

	it("trims at most once per minute: a second drop to zero inside it is skipped, one after it trims", () => {
		const harness = createTrimmer();
		harness.setSessions(1);
		harness.setSessions(0);
		harness.tick();
		harness.advance(ZERO_SESSION_TRIM_MIN_INTERVAL_MS - 1);
		harness.allocate(400);
		harness.setSessions(1);
		harness.setSessions(0);
		harness.tick();
		expect(harness.records).toHaveLength(1);
		harness.advance(1);
		harness.setSessions(1);
		harness.setSessions(0);
		harness.tick();
		expect(harness.records.map((record) => record.footprintBeforeMb)).toEqual([500, 400]);
	});

	it("still reports, uncollected, where the runtime exposes no full collection", () => {
		const harness = createTrimmer({ collect: () => false });
		harness.setSessions(1);
		harness.setSessions(0);
		harness.tick();
		expect(harness.records).toEqual([
			{
				type: "host_trimmed",
				footprintBeforeMb: 500,
				footprintAfterMb: 500,
				measure: "phys_footprint",
				collected: false,
			},
		]);
	});
});
