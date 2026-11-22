import { describe, expect, it, vi } from "vitest";
import {
	DECLINE_TRIM_FLOOR_BYTES,
	ZERO_SESSION_TRIM_MIN_INTERVAL_MS,
	ZERO_SESSION_TRIM_TICK_MS,
	ZeroSessionTrimmer,
} from "../../src/modes/rpc/host-zero-session-trim.ts";
import type { RpcHostTrimmedEvent } from "../../src/modes/rpc/rpc-types.ts";

const MEGABYTE = 1024 * 1024;

function createTrimmer(options: { collect?: () => boolean; pauseMs?: number } = {}) {
	let clock = 0;
	let sessions = 0;
	let footprintMb = 500;
	const records: RpcHostTrimmedEvent[] = [];
	let collections = 0;
	const trimmer = new ZeroSessionTrimmer({
		emit: (record) => records.push(record),
		sessions: () => sessions,
		now: () => clock,
		monotonicNow: () => clock,
		readFootprint: () => ({ bytes: footprintMb * MEGABYTE, measure: "phys_footprint" }),
		collect:
			options.collect ??
			(() => {
				collections += 1;
				clock += options.pauseMs ?? 0;
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
				sessions: 0,
				pauseMs: 0,
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

	it("answers a drop to zero inside the spacing once it ends, if the host is still empty (senpi#3360)", () => {
		const harness = createTrimmer();
		harness.setSessions(1);
		harness.setSessions(0);
		harness.tick();
		harness.advance(30_000);
		harness.allocate(400);
		harness.setSessions(20);
		harness.setSessions(0);
		harness.tick();
		expect(harness.records).toHaveLength(1);

		harness.advance(ZERO_SESSION_TRIM_MIN_INTERVAL_MS - 30_000);
		harness.tick();
		harness.tick();
		harness.tick();

		expect(harness.records.map((record) => [record.footprintBeforeMb, record.sessions])).toEqual([
			[500, 0],
			[400, 0],
		]);
		expect(harness.collections()).toBe(2);
	});

	it("drops a pending zero edge when sessions come back before the spacing ends (senpi#3360)", () => {
		const harness = createTrimmer();
		harness.setSessions(1);
		harness.setSessions(0);
		harness.tick();
		harness.advance(30_000);
		harness.setSessions(2);
		harness.setSessions(0);
		harness.setSessions(1);
		harness.advance(ZERO_SESSION_TRIM_MIN_INTERVAL_MS);
		harness.tick();

		expect(harness.collections()).toBe(1);
	});

	it("trims a busy host whose session count drops while its footprint is at least the floor (senpi#3218)", () => {
		// Given: a DAG shard that held 3 sessions and grew to 3 GB.
		const harness = createTrimmer();
		harness.setSessions(3);
		harness.allocate(3 * 1024);
		// When: two of its children end while one is still running.
		harness.setSessions(1);
		harness.tick();
		// Then: it collects once without waiting for zero sessions.
		expect(harness.collections()).toBe(1);
		expect(harness.records).toEqual([
			{
				type: "host_trimmed",
				footprintBeforeMb: 3 * 1024,
				footprintAfterMb: 120,
				measure: "phys_footprint",
				collected: true,
				sessions: 1,
				pauseMs: 0,
			},
		]);
	});

	it("sees a drop that a new session backfills before the next tick (senpi#3218 review)", () => {
		// Given: a pool held at its concurrency cap of 3 on a 3 GB host.
		const harness = createTrimmer();
		harness.setSessions(3);
		harness.allocate(3 * 1024);
		// When: a child closes and the next one opens within the same second.
		harness.trimmer.observe(2);
		harness.trimmer.observe(3);
		harness.tick();
		// Then: the drop still counts.
		expect(harness.collections()).toBe(1);
	});

	it("collects at exactly the floor", () => {
		const harness = createTrimmer();
		harness.setSessions(2);
		harness.allocate(DECLINE_TRIM_FLOOR_BYTES / MEGABYTE);
		harness.setSessions(1);
		expect(harness.collections()).toBe(1);
	});

	it("does not collect on a session-count drop below the floor or within the interval", () => {
		const harness = createTrimmer();
		harness.setSessions(3);
		harness.allocate(DECLINE_TRIM_FLOOR_BYTES / MEGABYTE - 1);
		harness.setSessions(2);
		expect(harness.collections()).toBe(0);
		harness.allocate(3 * 1024);
		harness.setSessions(1);
		expect(harness.collections()).toBe(1);
		harness.tick();
		harness.allocate(3 * 1024);
		harness.advance(ZERO_SESSION_TRIM_MIN_INTERVAL_MS - 1);
		harness.setSessions(3);
		harness.setSessions(2);
		expect(harness.collections()).toBe(1);
		harness.advance(1);
		harness.setSessions(1);
		expect(harness.collections()).toBe(2);
	});

	it("spaces busy-host trims by at least 100 times the last collection's pause", () => {
		// Given: a busy 3 GB host whose collection blocks the loop for 1 s.
		const harness = createTrimmer({ pauseMs: 1_000 });
		harness.setSessions(3);
		harness.allocate(3 * 1024);
		harness.setSessions(2);
		harness.tick();
		expect(harness.records[0]).toMatchObject({ sessions: 2, pauseMs: 1_000 });
		// When: the next drop comes after 60 s but before 100 s from the end of that collection.
		harness.allocate(3 * 1024);
		harness.advance(100_000 - 1);
		harness.setSessions(1);
		// Then: it waits for the pause-scaled interval.
		expect(harness.collections()).toBe(1);
		harness.advance(1);
		harness.setSessions(3);
		harness.setSessions(2);
		expect(harness.collections()).toBe(2);
	});

	it("trims once the interval ends for a drop that landed inside it, with no new drop", () => {
		// Given: a busy 3 GB host that just trimmed.
		const harness = createTrimmer();
		harness.setSessions(5);
		harness.allocate(3 * 1024);
		harness.setSessions(4);
		harness.tick();
		expect(harness.collections()).toBe(1);
		// When: its children close inside the interval and the rest keep running at a steady count.
		harness.allocate(3 * 1024);
		harness.advance(10_000);
		harness.setSessions(1);
		expect(harness.collections()).toBe(1);
		harness.advance(ZERO_SESSION_TRIM_MIN_INTERVAL_MS - 10_000 - 1);
		harness.tick();
		expect(harness.collections()).toBe(1);
		// Then: the held drop is answered on the first tick after the interval.
		harness.advance(1);
		harness.tick();
		expect(harness.collections()).toBe(2);
		harness.tick();
		expect(harness.records[1]).toMatchObject({ sessions: 1 });
		// And: it is answered once, not on every later tick.
		harness.allocate(3 * 1024);
		harness.advance(10 * ZERO_SESSION_TRIM_MIN_INTERVAL_MS);
		harness.tick();
		expect(harness.collections()).toBe(2);
	});

	it("never trims a busy host above the floor whose session count stays flat or rises", () => {
		const harness = createTrimmer();
		harness.allocate(3 * 1024);
		harness.setSessions(2);
		harness.advance(10 * ZERO_SESSION_TRIM_MIN_INTERVAL_MS);
		harness.tick();
		harness.setSessions(4);
		harness.advance(10 * ZERO_SESSION_TRIM_MIN_INTERVAL_MS);
		harness.tick();
		expect(harness.collections()).toBe(0);
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
				sessions: 0,
				pauseMs: 0,
			},
		]);
	});

	it("runs no timer while the session count holds still, and ticks on its own once one is owed (senpi#3747)", async () => {
		vi.useFakeTimers();
		let reads = 0;
		let sessions = 2;
		const records: RpcHostTrimmedEvent[] = [];
		const trimmer = new ZeroSessionTrimmer({
			emit: (record) => records.push(record),
			sessions: () => {
				reads += 1;
				return sessions;
			},
			readFootprint: () => ({ bytes: 500 * MEGABYTE, measure: "phys_footprint" }),
			collect: () => true,
		});
		try {
			trimmer.observe(2);
			trimmer.start();
			await vi.advanceTimersByTimeAsync(10_000);
			expect(reads).toBe(0);

			sessions = 0;
			trimmer.observe(0);
			await vi.advanceTimersByTimeAsync(2 * ZERO_SESSION_TRIM_TICK_MS);
			expect(records).toHaveLength(1);

			reads = 0;
			await vi.advanceTimersByTimeAsync(10_000);
			expect(reads).toBe(0);
		} finally {
			trimmer.stop();
			vi.useRealTimers();
		}
	});
});
