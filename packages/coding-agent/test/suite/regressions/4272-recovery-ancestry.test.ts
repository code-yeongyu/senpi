import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import type { TranscriptTransition } from "../../../src/core/session-transcript-journal.ts";
import { DEFAULT_TRANSCRIPT_ANCESTRY_BYTES } from "../../../src/modes/rpc/accepted-transcript.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { catalogOf, entryMember } from "./4272-catalog-read-support.ts";
import { recoveryRig } from "./4272-recovery-support.ts";

// Part of #4272 (S10a fold, RULING-61 Q1 = C): the lane retains {parentId, type} per accepted entry of its epoch, so
// every transcript row of the epoch carries its kind and family and the opaque family is counted exactly, whether or
// not persistence already released the entry's text; the loaded base stays a file range the catalog reports as
// partial, never as complete or empty; the retained ancestry is bounded and freed with the epoch.

afterEach(() => {
	vi.restoreAllMocks();
});

const MiB = 1024 * 1024;
const fileIdentity = { path: "/nowhere/s.jsonl", dev: "1", ino: "1" };
const persistence = (count: number) => ({ fileIdentity, count });
const unknown = { type: "ext_timeline_group", id: "e1", parentId: "e0", timestamp: "t", group: { title: "g" } };
const message = { type: "message", id: "e0", parentId: null, timestamp: "t", message: { role: "user", content: "hi" } };
const appended = (entry: { type: string; id: string; parentId: string | null }): TranscriptTransition => ({
	kind: "append",
	id: entry.id,
	type: entry.type,
	parentId: entry.parentId,
	entry: JSON.stringify(entry),
});

it("RULING-61 Q1 (a) an unknown-kind entry of this epoch whose text persistence already released still carries its kind and counts in opaque", async () => {
	// Given: two entries of this epoch appended with their text, then the file covering both (the tail drops the text)
	const rig = recoveryRig();
	rig.lane.applyTranscript([appended(message), appended(unknown)]);
	rig.lane.applyTranscript([
		{ kind: "persisted", persistence: persistence(2) },
		{ kind: "leaf", leafId: "e1" },
	]);
	const probe = rig.lane.freeze();
	expect(probe.transcript.tail.entries.size, "the tail no longer holds either entry").toBe(0);
	rig.lane.release(probe);
	// When: the cut is cataloged
	const catalog = await catalogOf(rig);
	// Then: both rows carry kind and family, the opaque family has exactly one member, and it is never declared empty
	expect(catalog.entries.filter(([kind]) => kind === "transcript" || kind === "opaque")).toEqual([
		["transcript", "transcript"],
		["transcript", entryMember(0)],
		["transcript", entryMember(1)],
		["opaque", entryMember(1)],
	]);
	expect(await catalog.json("transcript", entryMember(0))).toEqual({
		index: 0,
		id: "e0",
		source: "file",
		parentId: null,
		kind: "message",
		family: "transcript",
	});
	const row = { index: 1, id: "e1", source: "file", parentId: "e0", kind: "ext_timeline_group", family: "opaque" };
	expect(await catalog.json("transcript", entryMember(1))).toEqual(row);
	expect(await catalog.json("opaque", entryMember(1)), "the member names its file source; S11 streams it").toEqual(
		row,
	);
	const registry = await catalog.json("families", "families");
	expect(registry).toMatchObject({
		assembly: "incomplete",
		families: expect.arrayContaining([
			{ family: "transcript", producer: "complete" },
			{ family: "opaque", producer: "complete" },
		]),
	});
	catalog.release();
	await rig.lane.idle();
});

it("RULING-61 Q1 (a) an entry accepted already persisted (no text ever retained) is cataloged with its kind, and a retained unknown entry keeps its exact line", async () => {
	// Given: the first entry arrives persisted (no text), the second is retained by the tail
	const rig = recoveryRig();
	rig.lane.applyTranscript([
		{ kind: "append", id: "e0", type: "message", parentId: null, persistence: persistence(1) },
		appended(unknown),
	]);
	// When: the cut is cataloged
	const catalog = await catalogOf(rig);
	// Then: the persisted entry's row is exact, and the retained unknown entry's opaque member is its exact line
	expect(await catalog.json("transcript", entryMember(0))).toEqual({
		index: 0,
		id: "e0",
		source: "file",
		parentId: null,
		kind: "message",
		family: "transcript",
	});
	expect(await catalog.json("transcript", entryMember(1))).toMatchObject({
		source: "tail",
		kind: "ext_timeline_group",
	});
	expect((await catalog.text("opaque", entryMember(1))).text).toBe(JSON.stringify(unknown));
	expect(catalog.entries).not.toContainEqual(["opaque", "opaque"]);
	catalog.release();
	await rig.lane.idle();
});

it("RULING-61 Q1 (b) a loaded base is a file range: transcript and opaque are partial and opaque is never complete or empty", async () => {
	// Given: an epoch bootstrapped on a loaded base of three entries whose kinds the lane never saw
	const rig = recoveryRig();
	const base = { fileIdentity, count: 3, idFingerprint: "ab".repeat(32) };
	rig.lane.bootstrap({
		transcript: [
			{ kind: "replace", base },
			{ kind: "leaf", leafId: "b2" },
		],
	});
	// When: the cut is cataloged
	const catalog = await catalogOf(rig);
	// Then: the base is one file-range row, both producers are partial, and no opaque component claims emptiness
	expect(catalog.entries.filter(([kind]) => kind === "transcript" || kind === "opaque")).toEqual([
		["transcript", "transcript"],
		["transcript", "base"],
	]);
	expect(await catalog.json("transcript", "base")).toEqual({
		source: "file",
		first: 0,
		count: 3,
		idFingerprint: base.idFingerprint,
	});
	expect(await catalog.json("families", "families")).toMatchObject({
		assembly: "incomplete",
		families: expect.arrayContaining([
			{ family: "transcript", producer: "partial" },
			{ family: "opaque", producer: "partial" },
		]),
	});
	catalog.release();
	// Given: an unknown-kind entry accepted in this epoch on top of the same base
	rig.lane.applyTranscript([appended({ ...unknown, parentId: "b2" })]);
	// When: the cut is cataloged again
	const after = await catalogOf(rig);
	// Then: this epoch's member is exact while the family stays partial
	expect(after.entries.filter(([kind]) => kind === "opaque")).toEqual([["opaque", entryMember(0)]]);
	expect(await after.json("families", "families")).toMatchObject({
		families: expect.arrayContaining([{ family: "opaque", producer: "partial" }]),
	});
	after.release();
	await rig.lane.idle();
});

setFlagsFromString("--expose-gc");
const gc: () => void = runInNewContext("gc");
const heapUsed = () => {
	gc();
	gc();
	return process.memoryUsage().heapUsed;
};
const id = (index: number) => index.toString(16).padStart(8, "0");
/** A worker frame of `count` appends as the host parses it: every string its own instance. */
const frame = (count: number): TranscriptTransition[] =>
	JSON.parse(
		JSON.stringify(
			Array.from({ length: count }, (_, index) => ({
				kind: "append",
				id: id(index),
				type: index % 7 === 0 ? "ext_timeline_group" : "message",
				parentId: index === 0 ? null : id(index - 1),
			})),
		),
	);

it("RULING-61 (1) the retained ancestry is measured per record, bounded for 100,000 entries, and freed at epoch end and at retirement", async () => {
	const count = 100_000;
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: [] });
	try {
		// Given: an empty epoch
		const baseline = heapUsed();
		// When: 100,000 entries of engine shape are accepted without their text
		let transitions: TranscriptTransition[] | undefined = frame(count);
		lane.applyTranscript(transitions);
		transitions = undefined;
		const retained = heapUsed() - baseline;
		let root: ReturnType<typeof lane.freeze> | undefined = lane.freeze();
		// Then: the lane accounts every record (two slots + its content) and the heap cost per record is bounded
		const slots = 16 * count;
		const parents = 8 * (count - 1);
		const kinds =
			Math.ceil(count / 7) * "ext_timeline_group".length + (count - Math.ceil(count / 7)) * "message".length;
		expect(root.transcript.count).toBe(count);
		expect(root.transcript.ancestryBytes).toBe(slots + parents + kinds);
		expect(root.transcript.kinds[7]).toBe("ext_timeline_group");
		expect(root.transcript.parents[1]).toBe(root.transcript.entryIds[0]);
		const perRecord = retained / count;
		console.log(
			`RULING-61 measured: ${perRecord.toFixed(1)} heap bytes per retained record (ids + kinds + parents), ${(
				retained / MiB
			).toFixed(
				2,
			)} MiB for ${count} entries; accounted ancestry ${(root.transcript.ancestryBytes / MiB).toFixed(2)} MiB of the ${
				DEFAULT_TRANSCRIPT_ANCESTRY_BYTES / MiB
			} MiB budget`,
		);
		expect(perRecord).toBeLessThan(256);
		expect(root.transcript.ancestryBytes).toBeLessThan(DEFAULT_TRANSCRIPT_ANCESTRY_BYTES);
		// When: the epoch ends (a new bootstrap) and the frozen root is dropped
		lane.release(root);
		root = undefined;
		lane.bootstrap({ transcript: [] });
		// Then: the retained ancestry is freed with the epoch
		const afterEpoch = heapUsed() - baseline;
		expect(afterEpoch, "epoch end frees the retained ancestry").toBeLessThan(retained / 10);
		// When: a second epoch retains the same and the lane retires
		lane.applyTranscript(frame(count));
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
