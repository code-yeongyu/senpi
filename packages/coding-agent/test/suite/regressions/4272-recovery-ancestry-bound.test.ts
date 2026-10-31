import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import type { TranscriptTransition } from "../../../src/core/session-transcript-journal.ts";
import { DEFAULT_TRANSCRIPT_ANCESTRY_BYTES } from "../../../src/modes/rpc/accepted-transcript.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";

// Part of #4272 (S10a fold, RULING-61 condition (1)): the ancestry an epoch retains per accepted entry is charged at
// no less than the heap it really holds, for every record shape down to minimum strings, so the 8 MiB budget bounds
// the heap and the record count; it is freed at epoch end and at retirement, and over budget the transcript is
// unavailable with a typed reason.

afterEach(() => {
	vi.restoreAllMocks();
});

const MiB = 1024 * 1024;
setFlagsFromString("--expose-gc");
const gc: () => void = runInNewContext("gc");
const heapUsed = () => {
	gc();
	gc();
	return process.memoryUsage().heapUsed;
};
const hex = (index: number) => index.toString(16).padStart(8, "0");
interface AncestryRecord {
	readonly id: string;
	readonly type: string;
	readonly parentId: string | null;
}
type Shape = (index: number) => AncestryRecord;
const engine: Shape = (index) => ({
	id: hex(index),
	type: index % 7 === 0 ? "ext_timeline_group" : "message",
	parentId: index === 0 ? null : hex(index - 1),
});
const minimum: Shape = () => ({ id: "", type: "", parentId: null });
const twoByte: Shape = (index) => ({ id: `項${hex(index)}`, type: "message", parentId: `p${hex(index)}` });
/** A worker frame of `count` appends as the host parses it: every string its own instance. */
const frame = (count: number, shape: Shape, from = 0): TranscriptTransition[] =>
	JSON.parse(
		JSON.stringify(Array.from({ length: count }, (_, index) => ({ kind: "append", ...shape(from + index) }))),
	);
/** Accepts `count` records into the lane from a frame no caller register keeps alive once this returns. */
const accept = (lane: SessionAcceptanceLane, count: number, shape: Shape, from = 0): void => {
	lane.applyTranscript(frame(count, shape, from));
};
/** On stderr, which the runner prints for passing tests too, so every run carries its measurement. */
const report = (label: string, count: number, retained: number, charged: number) =>
	process.stderr.write(
		`RULING-61 measured (${label}): ${(retained / count).toFixed(1)} heap B and ${(charged / count).toFixed(1)} charged B per record; ${(retained / MiB).toFixed(2)} MiB heap, ${(charged / MiB).toFixed(2)} MiB charged for ${count} records of the ${DEFAULT_TRANSCRIPT_ANCESTRY_BYTES / MiB} MiB budget\n`,
	);

it("RULING-61 (1) the charged ancestry covers the measured heap of every record shape", () => {
	for (const [label, shape, count] of [
		["engine", engine, 100_000],
		["minimum strings", minimum, 100_000],
		["two-byte ids, unshared parents", twoByte, 50_000],
	] as const) {
		// Given: an empty epoch
		const lane = new SessionAcceptanceLane();
		lane.bootstrap({ transcript: [] });
		const baseline = heapUsed();
		// When: `count` records of the shape are accepted without their text
		accept(lane, count, shape);
		const retained = heapUsed() - baseline;
		const root = lane.freeze();
		report(label, count, retained, root.transcript.ancestryBytes);
		// Then: every record is retained and the charge is never below the heap they hold
		expect(root.transcript.unavailable, label).toBeNull();
		expect(root.transcript.count, label).toBe(count);
		expect(retained, `${label}: the charge covers the heap`).toBeLessThanOrEqual(root.transcript.ancestryBytes);
		lane.release(root);
		lane.retire("close");
	}
}, 60_000);

it("RULING-61 (1) the budget bounds the heap even for minimum-string records: the epoch stops at the budget", () => {
	// Given: an empty epoch
	const quiet = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: [] });
	const baseline = heapUsed();
	// When: minimum-string records are accepted until the budget refuses one
	let from = 0;
	while (lane.freeze().transcript.unavailable === null) {
		accept(lane, 20_000, minimum, from);
		from += 20_000;
	}
	const retained = heapUsed() - baseline;
	const root = lane.freeze();
	quiet.mockRestore();
	report("minimum strings to the budget", root.transcript.count, retained, root.transcript.ancestryBytes);
	// Then: the refusal is typed, more than the ruling's 100,000 entries fit, and the heap stays within the budget
	expect(root.transcript.unavailable).toBe("transcript_ancestry_over_byte_limit");
	expect(root.transcript.count).toBeGreaterThan(100_000);
	expect(root.transcript.ancestryBytes).toBeLessThanOrEqual(DEFAULT_TRANSCRIPT_ANCESTRY_BYTES);
	expect(retained, "the 8 MiB budget bounds the retained heap").toBeLessThanOrEqual(DEFAULT_TRANSCRIPT_ANCESTRY_BYTES);
	lane.retire("close");
}, 60_000);

it("RULING-61 (1) the retained ancestry is bounded for 100,000 entries and freed at epoch end and at retirement", async () => {
	const count = 100_000;
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: [] });
	try {
		// Given: an empty epoch
		const baseline = heapUsed();
		// When: 100,000 entries of engine shape are accepted without their text
		accept(lane, count, engine);
		const retained = heapUsed() - baseline;
		let root: ReturnType<typeof lane.freeze> | undefined = lane.freeze();
		// Then: the lane retains every record's kind and shared parent link, within the budget and over the heap
		expect(root.transcript.count).toBe(count);
		const [first, second, , , , , , seventh] = root.transcript.accepted;
		expect(seventh?.kind).toBe("ext_timeline_group");
		expect(second?.parentId).toBe(first?.id);
		report("engine, epoch", count, retained, root.transcript.ancestryBytes);
		expect(retained).toBeLessThanOrEqual(root.transcript.ancestryBytes);
		expect(root.transcript.ancestryBytes).toBeLessThan(DEFAULT_TRANSCRIPT_ANCESTRY_BYTES);
		// When: the epoch ends (a new bootstrap) and the frozen root is dropped
		lane.release(root);
		root = undefined;
		lane.bootstrap({ transcript: [] });
		// Then: the retained ancestry is freed with the epoch
		const afterEpoch = heapUsed() - baseline;
		expect(afterEpoch, "epoch end frees the retained ancestry").toBeLessThan(retained / 10);
		// When: a second epoch retains the same and the lane retires
		accept(lane, count, engine);
		expect(lane.freeze().transcript.count).toBe(count);
		lane.retire("close");
		// Then: retirement frees it too
		const afterRetire = heapUsed() - baseline;
		expect(afterRetire, "retirement frees the retained ancestry").toBeLessThan(retained / 10);
	} finally {
		lane.retire("close");
		await lane.idle();
	}
}, 60_000);

it("RULING-61 (1) ancestry over its byte budget leaves the epoch's transcript unavailable with a typed reason, never a silent drop", () => {
	// Given: an epoch holding a few bytes of ancestry
	const lane = new SessionAcceptanceLane(undefined, () => {});
	lane.bootstrap({ transcript: [] });
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	lane.applyTranscript([{ kind: "append", id: "e0", type: "message", parentId: null }]);
	// When: one entry's kind alone would exceed the budget
	lane.applyTranscript([
		{ kind: "append", id: "e1", type: "x".repeat(DEFAULT_TRANSCRIPT_ANCESTRY_BYTES), parentId: "e0" },
	]);
	// Then: the transcript is unavailable with its typed reason and the entry was not retained
	const root = lane.freeze();
	expect(root.transcript.unavailable).toBe("transcript_ancestry_over_byte_limit");
	expect(root.transcript.count).toBe(1);
	expect(stderr).toHaveBeenCalledWith(expect.stringContaining("transcript_ancestry_over_byte_limit"));
	lane.release(root);
	lane.retire("close");
});
