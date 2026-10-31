import { afterEach, expect, it, vi } from "vitest";
import type { TranscriptTransition } from "../../../src/core/session-transcript-journal.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { catalogOf, entryMember } from "./4272-catalog-read-support.ts";
import { recoveryRig } from "./4272-recovery-support.ts";

// Part of #4272 (S10a fold, RULING-61 Q1 = C): the lane retains {parentId, type} per accepted entry of its epoch, so
// every transcript row of the epoch carries its kind and family and the opaque family is counted exactly, whether or
// not persistence already released the entry's text; the loaded base stays a file range the catalog reports as
// partial, never as complete or empty; a root frozen at N entries names exactly those N while the lane accepts more.
// The retained ancestry's bound is 4272-recovery-ancestry-bound.test.ts.

afterEach(() => {
	vi.restoreAllMocks();
});

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

it("RULING-61 Q1 a root frozen at N entries keeps exactly N while the lane accepts more", () => {
	// Given: an epoch with one accepted entry and a root frozen there
	const lane = new SessionAcceptanceLane(undefined, () => {});
	lane.bootstrap({ transcript: [] });
	lane.applyTranscript([appended(message)]);
	const root = lane.freeze();
	// When: the lane accepts another entry after the freeze
	lane.applyTranscript([appended(unknown)]);
	// Then: the frozen root still names exactly its one entry, with its kind and parent link
	expect(root.transcript.count).toBe(1);
	expect([...root.transcript.accepted]).toEqual([{ index: 0, id: "e0", kind: "message", parentId: null }]);
	expect(root.transcript.accepted.idsBefore(2), "a read past the count stops at it").toEqual(["e0"]);
	expect(lane.freeze().transcript.count, "the live epoch has both").toBe(2);
	lane.release(root);
	lane.retire("close");
});

it("RULING-61 Q1 a cut frozen at N entries is cataloged with exactly N rows after the lane accepts more", async () => {
	// Given: one accepted entry, then a cut, then two more entries (one of an unknown kind) accepted after it
	const rig = recoveryRig();
	rig.lane.applyTranscript([appended(message)]);
	const later = [appended(unknown), appended({ ...message, id: "e2", parentId: "e1" })];
	// When: the frozen cut is cataloged after the later entries arrived
	const catalog = await catalogOf(rig, () => rig.lane.applyTranscript(later));
	// Then: exactly the cut's one row, its count, and an opaque family with no member from after the cut
	expect(catalog.entries.filter(([kind]) => kind === "transcript" || kind === "opaque")).toEqual([
		["transcript", "transcript"],
		["transcript", entryMember(0)],
		["opaque", "opaque"],
	]);
	expect(await catalog.json("transcript", "transcript")).toMatchObject({ count: 1, leafId: "e0" });
	catalog.release();
	await rig.lane.idle();
});
