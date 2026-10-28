import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { readTranscriptRoot } from "../../../src/modes/rpc/accepted-transcript.ts";
import { TailBudget, TranscriptTail } from "../../../src/modes/rpc/accepted-transcript-tail.ts";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { TransferStaging } from "../../../src/modes/rpc/compact-transfer-staging.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";

// Part of #4272, carried from the S12a reviews (RULING-79): the accepted tail's bound covers every segment it keeps for
// held cuts (65a), and a tail superseded under a live cut gives its RAM back to the version after it (66).

const MIB = 1024 * 1024;
let dir = "";
beforeEach(async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	dir = await mkdtemp(join(tmpdir(), "senpi-4272-carried-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(dir, { recursive: true, force: true });
});

/** Stored bytes of one staged entry text: two per UTF-16 code unit. */
const ENTRY = "e".repeat(4_000);
const ENTRY_BYTES = ENTRY.length * 2;

// 65a: segments kept for held cuts leave `retainedBytes` but stay in the spool, so they must stay in the bound.
it("S12b carry 65a: held cuts cannot push the tail's spool past its stated bound; their release frees the room", async () => {
	const store = new CompactContentStore({ dir: join(dir, "spool"), spillAboveBytes: 0, spillTargetBytes: 0 });
	const staging = new TransferStaging(store);
	const budget = new TailBudget(4 * ENTRY_BYTES);
	const tail = new TranscriptTail(staging, null, budget);
	const append = (index: number): boolean => {
		const content = tail.stage(index, ENTRY);
		if (content) tail.adopt(index, content);
		return content !== undefined;
	};
	for (let index = 0; index < 3; index++) expect(append(index)).toBe(true);
	tail.retainCut(3);
	tail.persisted({ count: 3, fileIdentity: { path: join(dir, "session.jsonl"), dev: "1", ino: "1" } }, 0);
	expect(tail.retainedBytes, "persistence released the tail's own ownership").toBe(0);
	expect(tail.kept.size, "the held cut keeps its three segments in the spool").toBe(3);
	expect(append(3), "kept 3 + 1 new is exactly the bound").toBe(true);
	expect(append(4), "a fifth entry would put the spool past the bound").toBe(false);
	const held = [...tail.entries.values(), ...tail.kept.values()].reduce((sum, each) => sum + each.ref.entry.length, 0);
	expect(held, "the spool never holds more than the stated bound").toBeLessThanOrEqual(budget.max);
	tail.releaseCut(3);
	expect(append(4), "the released cut's segments left the bound").toBe(true);
	tail.releaseAll();
	expect(budget.held).toBe(0);
	await staging.close();
});

// 66: the review's exact sequence. A root held across a replace keeps the old version's unpersisted entries; they must
// leave RAM (spilled, still readable) so the new version's appends are not refused at the shared resident bound.
it("S12b carry 66: a root held across a replace does not starve the new version's appends of resident room", async () => {
	const manager = SessionManager.create(dir, dir);
	// Spill only past 64 MiB, above the 32 MiB resident tail bound, so only an explicit spill moves a leaf.
	const lane = new SessionAcceptanceLane({
		dir: join(dir, "spool"),
		spillAboveBytes: 64 * MIB,
		spillTargetBytes: 32 * MIB,
	});
	lane.bootstrap({ transcript: manager.beginTranscriptJournal() });
	manager.appendCustomEntry("old", { text: "o".repeat(10_000_000) });
	lane.applyTranscript(manager.drainTranscript());
	const held = lane.freeze();
	manager.newSession();
	lane.applyTranscript(manager.drainTranscript());
	await lane.idle();
	manager.appendCustomEntry("new", { text: "n".repeat(10_000_000) });
	lane.applyTranscript(manager.drainTranscript());
	const current = lane.freeze();
	expect(current.transcript.unavailable, "the new version's append was not refused").toBeNull();
	const old = await readTranscriptRoot(held.transcript);
	expect(old.ok && old.entries.map((entry) => entry.type), "the held root still reads its own entries").toEqual([
		"session",
		"custom",
	]);
	lane.release(held);
	await lane.idle();
	expect(lane.storageStatus().transcript.residentPayloadBytes).toBe(current.transcript.tail.retainedBytes);
	lane.release(current);
	manager.dispose();
}, 120_000);

// RULING-80 (4) = C: an append refused while the superseded tail is still spilling is a typed refusal, and the version it
// refused becomes available again: the refused text is never kept outside the budget, so once the spill completed, the
// root is released and the refused entry is durable, the version reads whole again and takes later appends.
it("S12b RULING-80 (4): a version refused during the superseded tail's spill is available again once the spill completed and the root is released", async () => {
	const manager = SessionManager.create(dir, dir);
	const lane = new SessionAcceptanceLane({
		dir: join(dir, "spool"),
		spillAboveBytes: 64 * MIB,
		spillTargetBytes: 32 * MIB,
	});
	lane.bootstrap({ transcript: manager.beginTranscriptJournal() });
	manager.appendCustomEntry("old", { text: "o".repeat(10_000_000) });
	lane.applyTranscript(manager.drainTranscript());
	const held = lane.freeze();
	manager.newSession();
	lane.applyTranscript(manager.drainTranscript());
	// Still inside the window: the superseded tail's spill is queued, not complete.
	manager.appendCustomEntry("refused", { text: "r".repeat(10_000_000) });
	lane.applyTranscript(manager.drainTranscript());
	const refused = lane.freeze();
	expect(refused.transcript.unavailable, "refused in the window, typed").toBe("transcript_tail_over_byte_limit");
	lane.release(refused);
	await lane.idle();
	lane.release(held);
	await lane.idle();
	await manager.persistHeaderNow();
	lane.applyTranscript(manager.drainTranscript());
	manager.appendCustomEntry("later", { text: "after the window" });
	lane.applyTranscript(manager.drainTranscript());
	const recovered = lane.freeze();
	try {
		expect(recovered.transcript.unavailable, "the version is available again").toBeNull();
		const read = await readTranscriptRoot(recovered.transcript);
		if (!read.ok) throw new Error(read.error);
		expect(read.entries.map((entry) => entry.type)).toEqual(["session", "custom", "custom"]);
		const texts = read.entries.map((entry) => Reflect.get(Object(Reflect.get(entry, "data")), "text"));
		expect(texts[1], "the refused entry reads whole").toHaveLength(10_000_000);
		expect(texts[2], "a later append succeeds").toBe("after the window");
	} finally {
		lane.release(recovered);
		manager.dispose();
	}
}, 120_000);
