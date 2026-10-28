import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TranscriptTransition } from "../../../src/core/session-transcript-journal.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { readTranscriptRoot, type TranscriptRoot } from "../../../src/modes/rpc/accepted-transcript.ts";
import { CompactContentStore, COMPACT_LEAF_CODE_UNITS } from "../../../src/modes/rpc/compact-content-store.ts";
import { nodeCompactStorageIo } from "../../../src/modes/rpc/compact-storage-io.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";

// Part of #4272 (S12a, S12-design section 4): the accepted transcript tail spills to the lane's staging store instead of
// going unavailable at 16 MiB, and the internal bootstrap reader stages a bootstrap whole before publishing any of it.

const MIB = 1024 * 1024;
let dir = "";
beforeEach(async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	dir = await mkdtemp(join(tmpdir(), "senpi-4272-spill-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(dir, { recursive: true, force: true });
});

/** Large reads are compared by length and digest: a failing match must not make the runner diff 27 MB strings. */
const fingerprint = (bytes: string | Buffer) => ({
	length: bytes.length,
	sha256: createHash("sha256").update(bytes).digest("hex"),
});

const linesOf = async (root: TranscriptRoot): Promise<string> => {
	const read = await readTranscriptRoot(root);
	if (!read.ok) throw new Error(read.error);
	return `${read.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
};

const entry = (id: string, parentId: string | null, text: string): string =>
	JSON.stringify({
		type: "custom",
		customType: "spill",
		data: { text },
		id,
		parentId,
		timestamp: "2026-10-28T00:00:00.000Z",
	});

const append = (id: string, parentId: string | null, text: string): TranscriptTransition => ({
	kind: "append",
	id,
	type: "custom",
	parentId,
	entry: entry(id, parentId, text),
});

it("S12a T5 X03 X04: a tail past the old 16 MiB limit spills and stays whole; a read held across persistence completes from the tail and matches the file", async () => {
	const manager = SessionManager.create(dir, dir);
	const lane = new SessionAcceptanceLane({ dir: join(dir, "spool"), spillAboveBytes: MIB, spillTargetBytes: MIB / 2 });
	lane.bootstrap({ transcript: manager.beginTranscriptJournal() });
	for (let index = 0; index < 6; index++) {
		// 4.5 MiB of UTF-8 each: the fourth crosses the old 16 MiB accepted-tail limit.
		manager.appendCustomEntry("spill", { index, text: "한".repeat(1_500_000) });
		lane.applyTranscript(manager.drainTranscript());
		if (index < 5) await lane.idle();
	}
	// Frozen before the last spill runs.
	const held = lane.freeze();
	expect(held.transcript.unavailable, "the tail spills instead of going unavailable").toBeNull();
	await lane.idle();
	expect(lane.storageStatus()).toHaveProperty("transcript.residentPayloadBytes");
	const spilled = lane.storageStatus().transcript;
	expect(spilled.spilledLiveBytes, "accepted tail bytes live in the spool").toBeGreaterThan(16 * MIB);
	expect(spilled.residentPayloadBytes, "resident tail RAM is back under the spill threshold").toBeLessThanOrEqual(MIB);
	expect(held.transcript.tail.persistence, "no durability is claimed before the writer reports it").toBeNull();

	await manager.persistHeaderNow();
	// The read takes its hold now; persistence then drops the tail's own ownership before the read reads any leaf.
	const reading = linesOf(held.transcript);
	lane.applyTranscript(manager.drainTranscript());
	expect(held.transcript.tail.retainedBytes, "persistence released the tail, held cut included").toBe(0);
	const fromTail = await reading;
	const fromFile = await linesOf(held.transcript);
	expect(fingerprint(fromTail), "the held read completed from the tail").toEqual(fingerprint(fromFile));
	expect(fingerprint(Buffer.from(fromFile))).toEqual(fingerprint(readFileSync(String(manager.getSessionFile()))));
	// RULING-78 (1): the held cut keeps its spool segments until it is released.
	lane.release(held);
	await lane.idle();
	expect(lane.storageStatus().transcript).toMatchObject({
		residentPayloadBytes: 0,
		spilledLiveBytes: 0,
		reclaimDebtBytes: 0,
		stagedBytes: 0,
	});
	manager.dispose();
}, 120_000);

it("S12a T1 X04: a failed tail spool keeps accepted content resident and reported; an append over the resident bound is refused typed while a held cut still reads", async () => {
	const diagnostic = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	const io = {
		...nodeCompactStorageIo,
		writeFile: async () => {
			throw new Error("ENOSPC: injected spool failure");
		},
	};
	const manager = SessionManager.inMemory(dir);
	const lane = new SessionAcceptanceLane({
		dir: join(dir, "spool"),
		io,
		spillAboveBytes: MIB,
		spillTargetBytes: MIB / 2,
	});
	lane.bootstrap({ transcript: manager.beginTranscriptJournal() });
	for (let index = 0; index < 4; index++) {
		manager.appendCustomEntry("kept", { index, text: "x".repeat(1_000_000) });
		lane.applyTranscript(manager.drainTranscript());
		await lane.idle();
	}
	const held = lane.freeze();
	const before = await linesOf(held.transcript);
	expect(lane.storageStatus()).toHaveProperty("transcript.spillHalted", true);
	const status = lane.storageStatus().transcript;
	expect(status.failures.some((failure) => failure.operation === "spill_write")).toBe(true);
	expect(status.spillFailureRetainedBytes, "the retained RAM is reported").toBeGreaterThan(0);
	expect(status.residentPayloadBytes, "accepted content stays resident").toBeGreaterThanOrEqual(8_000_000);
	expect(held.transcript.unavailable).toBeNull();
	expect(held.transcript.tail.persistence, "a spool failure fabricates no durability").toBeNull();

	// 26 MB more resident would cross the 32 MiB resident bound: refused before any leaf for it exists.
	manager.appendCustomEntry("over", { text: "y".repeat(13_000_000) });
	lane.applyTranscript(manager.drainTranscript());
	const after = lane.freeze();
	expect(after.transcript.unavailable).toBe("transcript_tail_over_byte_limit");
	expect(await readTranscriptRoot(after.transcript)).toEqual({ ok: false, error: "transcript_tail_over_byte_limit" });
	expect(lane.storageStatus().transcript.residentPayloadBytes).toBe(status.residentPayloadBytes);
	expect(fingerprint(await linesOf(held.transcript)), "the earlier cut survives the refusal").toEqual(
		fingerprint(before),
	);
	expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("transcript_tail_over_byte_limit"));
	manager.dispose();
}, 120_000);

it("S12a X04 bootstrap reader: a bootstrap refused at a bound keeps nothing it staged and publishes no partial transcript", async () => {
	vi.spyOn(process.stderr, "write").mockReturnValue(true);
	const lane = new SessionAcceptanceLane({ dir: join(dir, "spool") });
	lane.bootstrap({
		transcript: [
			{ kind: "replace", base: null },
			append("first", null, "a".repeat(MIB)),
			// 34 MB stored (UTF-16LE): over the 32 MiB resident bound before any of its leaves exist.
			append("second", "first", "b".repeat(17_000_000)),
			{ kind: "leaf", leafId: "second" },
		],
	});
	const root = lane.freeze();
	expect(root.transcript.unavailable).toBe("transcript_tail_over_byte_limit");
	expect(root.transcript.tail.entries.size, "the first entry's staged content was released, never adopted").toBe(0);
	expect(lane.storageStatus()).toHaveProperty("transcript.stagedBytes", 0);
	expect(lane.storageStatus()).toHaveProperty("transcript.residentPayloadBytes", 0);
	expect(root.sequence, "staging takes no sequence").toBe(0);
	expect(await readTranscriptRoot(root.transcript)).toEqual({ ok: false, error: "transcript_tail_over_byte_limit" });
});

it("S12a X04 bootstrap reader: an entry larger than one fragment is staged as bounded leaves and read back whole", async () => {
	const create = vi.spyOn(CompactContentStore.prototype, "createLeaf");
	const lane = new SessionAcceptanceLane({ dir: join(dir, "spool") });
	const text = "😀".repeat(100_000);
	const transcript: TranscriptTransition[] = [
		{ kind: "replace", base: null },
		append("big", null, text),
		{ kind: "leaf", leafId: "big" },
	];
	const line = entry("big", null, text);
	lane.bootstrap({ transcript });
	const root = lane.freeze();
	expect(lane.storageStatus()).toHaveProperty("transcript.residentPayloadBytes", line.length * 2);
	const staged = create.mock.calls.filter(([leaf]) => line.includes(leaf));
	expect(staged.length, "one leaf per bounded piece").toBeGreaterThanOrEqual(
		Math.ceil(line.length / COMPACT_LEAF_CODE_UNITS),
	);
	expect(staged.every(([leaf]) => leaf.length <= COMPACT_LEAF_CODE_UNITS)).toBe(true);
	expect(await linesOf(root.transcript)).toBe(`${line}\n`);
});
