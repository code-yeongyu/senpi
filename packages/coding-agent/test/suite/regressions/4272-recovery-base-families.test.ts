import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFamilyRegistry } from "../../../src/modes/rpc/compact-catalog-registry.ts";
import { openBaseBytes } from "../../../src/modes/rpc/compact-recovery-base.ts";
import { FRAGMENT_MAX_BYTES, producePage } from "../../../src/modes/rpc/compact-recovery-bytes.ts";
import { type BaseEntry, stampedBytes, writeBase } from "./4272-base-file-support.ts";
import { catalogOf, entryMember } from "./4272-catalog-read-support.ts";
import { specDigest } from "./4272-frozen-bytes-support.ts";
import { recoveryRig } from "./4272-recovery-support.ts";

// Part of #4272 (S11c, RULING-61 acceptance "S11 turns the partial base into exact counts", RULING-59 A): with the
// base streamable, the families fed by entry kinds are complete: each of transcript, opaque and source names the base
// stream with a `base` member, so a reader counts every member exactly from the catalog plus the stream, and no family
// claims emptiness the stream could contradict. The stream of a base over 16 MiB is produced with one line resident.

let dir = "";

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "senpi-4272-base-families-"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await rm(dir, { recursive: true, force: true });
});

const unknown = { type: "ext_timeline_group", id: "x1", parentId: "e0", group: { title: "g" } };
const entries: readonly BaseEntry[] = [
	{ type: "session", id: "s0", version: 3 },
	{ type: "message", id: "e0", parentId: null, message: { role: "user", content: "hi" } },
	unknown,
	{ type: "label", id: "l1", parentId: "x1", label: "note" },
];
const baseRow = (base: { count: number; idFingerprint: string }) => ({
	source: "file",
	first: 0,
	count: base.count,
	idFingerprint: base.idFingerprint,
});

it("RULING-61 partial -> exact: with a loaded base every entry-fed family is complete and names the base stream; opaque and source never claim emptiness", async () => {
	// Given: an epoch bootstrapped on a loaded base holding a transcript, an opaque and a source member
	const base = await writeBase(join(dir, "s.jsonl"), entries);
	const rig = recoveryRig();
	rig.lane.bootstrap({
		transcript: [
			{ kind: "replace", base },
			{ kind: "leaf", leafId: "l1" },
		],
	});
	// When: the cut is cataloged
	const catalog = await catalogOf(rig);
	// Then: the registry is complete, and transcript, opaque and source each carry the base row and no explicit empty
	const registry = readFamilyRegistry((await catalog.text("families", "families")).text);
	expect(registry.assembly).toBe("complete");
	expect(catalog.entries.filter(([kind]) => ["transcript", "opaque", "source"].includes(kind))).toEqual([
		["transcript", "transcript"],
		["transcript", "base"],
		["opaque", "base"],
		["source", "base"],
	]);
	for (const family of ["transcript", "opaque", "source"])
		expect(await catalog.json(family, "base")).toEqual(baseRow(base));
	expect(await catalog.json("transcript", "transcript")).toMatchObject({
		count: 0,
		base: { count: base.count, idFingerprint: base.idFingerprint },
	});
	catalog.release();
	// Given: an unknown-kind entry and a label accepted in this epoch on top of the same base
	rig.lane.applyTranscript([
		{ kind: "append", id: "x2", type: "ext_timeline_group", parentId: "l1", entry: JSON.stringify(unknown) },
		{ kind: "append", id: "l2", type: "label", parentId: "x2", entry: JSON.stringify({ type: "label", id: "l2" }) },
	]);
	// When: the cut is cataloged again
	const after = await catalogOf(rig);
	// Then: this epoch's members sit beside the base row of their family, exact, and the assembly stays complete
	expect(after.entries.filter(([kind]) => kind === "opaque")).toEqual([
		["opaque", entryMember(0)],
		["opaque", "base"],
	]);
	expect(after.entries.filter(([kind]) => kind === "source")).toEqual([
		["source", entryMember(1)],
		["source", "base"],
	]);
	expect(readFamilyRegistry((await after.text("families", "families")).text).assembly).toBe("complete");
	after.release();
	await rig.lane.idle();
});

it("RULING-61 an unavailable transcript keeps the entry-fed families partial with no base stream to name", async () => {
	// Given: an epoch whose transcript is unavailable although a base was loaded
	const base = await writeBase(join(dir, "s.jsonl"), entries);
	const rig = recoveryRig();
	rig.lane.bootstrap({
		transcript: [
			{ kind: "replace", base },
			{ kind: "unavailable", reason: "transcript_tail_trimmed" },
		],
	});
	// When: the cut is cataloged
	const catalog = await catalogOf(rig);
	// Then: no family names the base and the three producers are partial
	expect(catalog.entries.filter(([, id]) => id === "base")).toEqual([]);
	const registry = readFamilyRegistry((await catalog.text("families", "families")).text);
	expect(registry.assembly === "incomplete" ? registry.incomplete : []).toEqual(["transcript", "opaque", "source"]);
	catalog.release();
	await rig.lane.idle();
});

it("RULING-59 A a base over 16 MiB streams its stamped rows with one line resident, never the file", async () => {
	// Given: a base of 2,048 entries whose lines carry 8.5 KiB each (over 16 MiB on disk)
	const payload = "x".repeat(8_700);
	const large: BaseEntry[] = [{ type: "session", id: "s0" }];
	for (let index = 1; index < 2_048; index++)
		large.push({ type: "message", id: `m-${index}`, parentId: `m-${index - 1}`, message: payload });
	const base = await writeBase(join(dir, "large.jsonl"), large);
	expect((await stat(base.fileIdentity.path)).size).toBeGreaterThan(16 * 1024 * 1024);
	const expected = stampedBytes(large);
	// When: the stream is opened and every page produced
	const reads: number[] = [];
	const bytes = await openBaseBytes(base, () => reads.push(1));
	const pages: Buffer[] = [];
	for (let offset = 0; ;) {
		const page = await producePage(bytes, offset);
		pages.push(page.bytes);
		expect(page.length).toBeLessThanOrEqual(FRAGMENT_MAX_BYTES);
		expect(specDigest("fragment", page.bytes)).toBe(page.digest);
		if (page.next === null) break;
		offset = page.next;
	}
	// Then: the join is exact, the open verified the whole file, and at most one line was resident at any time
	expect(pages.length).toBe(Math.ceil(expected.length / FRAGMENT_MAX_BYTES));
	expect(pages.length).toBeGreaterThanOrEqual(3);
	expect(Buffer.concat(pages).equals(expected)).toBe(true);
	expect(bytes.length).toBe(expected.length);
	expect(bytes.digest, "the stream's anchor is the fingerprint the open verified").toBe(base.idFingerprint);
	expect(bytes.peakResidentLeaves, "one line resident beside the read buffer").toBe(1);
	expect(reads.length, "the lease is rechecked on every read of the file").toBeGreaterThan((2_048 * 8_700) / 65_536);
});
