import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { readTranscriptRoot, type TranscriptRoot } from "../../../src/modes/rpc/accepted-transcript.ts";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { protocolId } from "../../../src/modes/rpc/compact-recovery-ids.ts";
import { TransferStaging } from "../../../src/modes/rpc/compact-transfer-staging.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";

// Part of #4272 (S12a, RULING-78 = A): the spool segments a held cut names outlive the cut, and every read by identity
// verifies the bytes it returns, failing typed when a segment is missing or mismatched.

const MIB = 1024 * 1024;
let dir = "";
beforeEach(async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	dir = await mkdtemp(join(tmpdir(), "senpi-4272-r78-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(dir, { recursive: true, force: true });
});

const fingerprint = (text: string) => ({
	length: text.length,
	sha256: createHash("sha256").update(text).digest("hex"),
});

const linesOf = async (root: TranscriptRoot): Promise<string> => {
	const read = await readTranscriptRoot(root);
	if (!read.ok) throw new Error(read.error);
	return `${read.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
};

const transcriptLeaves = async (spool: string): Promise<string[]> => {
	const store = (await readdir(spool)).find((name) => name.startsWith("senpi-transcript-"));
	if (!store) throw new Error("the transcript store spilled nothing");
	const files = (await readdir(join(spool, store))).filter((name) => name.startsWith("leaf-"));
	return files.sort().map((name) => join(spool, store, name));
};

it("S12a RULING-78 (1)(3): a held cut released at persistence, read after the tail rolls over and compaction runs, returns byte-identical content", async () => {
	const manager = SessionManager.create(dir, dir);
	const lane = new SessionAcceptanceLane({ dir: join(dir, "spool"), spillAboveBytes: MIB, spillTargetBytes: MIB / 2 });
	lane.bootstrap({ transcript: manager.beginTranscriptJournal() });
	for (let index = 0; index < 3; index++) {
		manager.appendCustomEntry("held", { index, text: "한".repeat(600_000) });
		lane.applyTranscript(manager.drainTranscript());
		await lane.idle();
	}
	const held = lane.freeze();
	const before = fingerprint(await linesOf(held.transcript));
	await manager.persistHeaderNow();
	lane.applyTranscript(manager.drainTranscript());
	expect(held.transcript.tail.retainedBytes, "persistence released the held cut's tail (RULING-21 (4))").toBe(0);
	for (let index = 0; index < 3; index++) {
		manager.appendCustomEntry("rollover", { index, text: "x".repeat(700_000) });
		lane.applyTranscript(manager.drainTranscript());
		await lane.idle();
	}
	await manager.persistHeaderNow();
	lane.applyTranscript(manager.drainTranscript());
	await lane.idle();
	// The file the entries were persisted into is replaced by another file holding the same bytes.
	const file = String(manager.getSessionFile());
	writeFileSync(`${file}.next`, readFileSync(file));
	renameSync(`${file}.next`, file);
	expect(lane.storageStatus().transcript.spilledLiveBytes, "the held cut's segments are still live").toBeGreaterThan(
		3 * 1_200_000,
	);
	expect(fingerprint(await linesOf(held.transcript)), "read from the cut's own segments").toEqual(before);
	lane.release(held);
	await lane.idle();
	expect(lane.storageStatus().transcript, "released with the last cut that names them").toMatchObject({
		spilledLiveBytes: 0,
		residentPayloadBytes: 0,
		reclaimDebtBytes: 0,
	});
	manager.dispose();
}, 120_000);

it("S12a RULING-78 (2)(3): a deliberately removed segment is the typed segment_missing, a changed one segment_mismatch; no other bytes are returned", async () => {
	const read = async (damage: (leaf: string) => Promise<void>) => {
		const spool = join(dir, `spool-${Math.random().toString(36).slice(2)}`);
		const manager = SessionManager.inMemory(dir);
		const lane = new SessionAcceptanceLane({ dir: spool, spillAboveBytes: 0, spillTargetBytes: 0 });
		lane.bootstrap({ transcript: manager.beginTranscriptJournal() });
		manager.appendCustomEntry("damaged", { text: "z".repeat(100_000) });
		lane.applyTranscript(manager.drainTranscript());
		await lane.idle();
		const held = lane.freeze();
		const [first] = await transcriptLeaves(spool);
		if (!first) throw new Error("no spilled leaf");
		await damage(first);
		const result = await readTranscriptRoot(held.transcript);
		manager.dispose();
		return result;
	};
	expect(await read((leaf) => unlink(leaf))).toEqual({ ok: false, error: "transcript_segment_missing" });
	expect(
		await read(async (leaf) => {
			const data = await readFile(leaf);
			data[0] = (data[0] ?? 0) ^ 1;
			await writeFile(leaf, data);
		}),
	).toEqual({ ok: false, error: "transcript_segment_mismatch" });
});

it("S12a RULING-78 (2): a staged read verifies every leaf before yielding it, so a segment changed mid-read never returns other bytes", async () => {
	const spool = join(dir, "staging");
	const store = new CompactContentStore({ dir: spool, spillAboveBytes: 0, spillTargetBytes: 0 });
	const staging = new TransferStaging(store);
	const text = `${"a".repeat(32_768)}${"b".repeat(32_768)}${"c".repeat(100)}`;
	const content = staging.stage(protocolId("staged"), protocolId("value-1"), text);
	staging.adopt(content);
	await store.idle();
	const leaves = (await readdir(spool)).filter((name) => name.startsWith("leaf-")).sort();
	expect(leaves).toHaveLength(3);
	const reading = staging.chunks(content);
	const first = await reading.next();
	expect(text.startsWith(String(first.value)), "what was yielded is the stored text").toBe(true);
	const last = join(spool, leaves[2] ?? "");
	const data = await readFile(last);
	// "c" becomes "#", a character the stored text never holds.
	data[0] = (data[0] ?? 0) ^ 0x40;
	await writeFile(last, data);
	const rest = (async () => {
		for (let next = await reading.next(); !next.done; next = await reading.next())
			expect(text.includes(next.value), "no changed bytes are yielded").toBe(true);
	})();
	await expect(rest).rejects.toMatchObject({ name: "StagedReadError", reason: "segment_mismatch" });
	await unlink(join(spool, leaves[1] ?? ""));
	const again = staging.chunks(content);
	await expect(
		(async () => {
			for await (const _chunk of again);
		})(),
	).rejects.toMatchObject({ name: "StagedReadError" });
});

it("S12a review HIGH: a root frozen before a replace still reads its own entries, and the superseded tail frees with its last cut", async () => {
	const manager = SessionManager.create(dir, dir);
	const lane = new SessionAcceptanceLane({ dir: join(dir, "spool") });
	lane.bootstrap({ transcript: manager.beginTranscriptJournal() });
	manager.appendMessage({ role: "user", content: "before the replace", timestamp: 1 });
	lane.applyTranscript(manager.drainTranscript());
	const held = lane.freeze();
	const types = async () => {
		const read = await readTranscriptRoot(held.transcript);
		return read.ok ? read.entries.map((entry) => entry.type) : read.error;
	};
	expect(await types()).toEqual(["session", "message"]);
	const before = await linesOf(held.transcript);
	manager.newSession();
	lane.applyTranscript(manager.drainTranscript());
	expect(await types(), "the replaced version still reads its own entries").toEqual(["session", "message"]);
	expect(await linesOf(held.transcript)).toBe(before);
	expect(lane.storageStatus().transcript.residentPayloadBytes, "the superseded tail is still held").toBeGreaterThan(0);
	lane.release(held);
	await lane.idle();
	const current = lane.freeze();
	expect(
		lane.storageStatus().transcript.residentPayloadBytes,
		"freed with the last cut, only the new tail is left",
	).toBe(current.transcript.tail.retainedBytes);
	lane.release(current);
	manager.dispose();
});
