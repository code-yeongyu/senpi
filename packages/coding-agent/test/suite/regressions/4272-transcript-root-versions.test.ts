import { readFileSync, renameSync, truncateSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { readTranscriptRoot, type TranscriptRoot } from "../../../src/modes/rpc/accepted-transcript.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";

let dir = "";

beforeEach(async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	dir = await mkdtemp(join(tmpdir(), "senpi-4272-transcript-"));
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(dir, { recursive: true, force: true });
});

function user(text: string) {
	return { role: "user" as const, content: text, timestamp: 1 };
}

/** A session whose conversation is on disk, reopened: its whole history is the persisted base of the bootstrap. */
async function reopened(): Promise<{ manager: SessionManager; lane: SessionAcceptanceLane; file: string }> {
	const writer = SessionManager.create(dir, dir);
	writer.appendMessage(user("first"));
	writer.appendMessage(user("second"));
	const file = String(writer.getSessionFile());
	writer.dispose();
	const manager = SessionManager.open(file, dir);
	await manager.persistHeaderNow();
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: manager.beginTranscriptJournal() });
	return { manager, lane, file };
}

function fileIds(file: string): string[] {
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => String(JSON.parse(line).id));
}

function rootIds(root: TranscriptRoot): string[] {
	const read = readTranscriptRoot(root);
	if (!read.ok) throw new Error(`transcript read failed: ${read.error}`);
	return read.entries.map((entry) => entry.id);
}

// Part of #4272, R3.C1.1: a root is a persisted base plus host-owned accepted transitions; a cut never reads past them.
it("C1.1 journal/cut: a cut reads its persisted base and accepted appends up to its count, never an entry persisted after it", async () => {
	const { manager, lane, file } = await reopened();
	const atBootstrap = lane.freeze();
	expect(atBootstrap.transcript.base?.count, "the load's parse: header and two messages").toBe(3);
	expect(atBootstrap.transcript.count, "everything loaded is on the base").toBe(0);
	expect(rootIds(atBootstrap.transcript)).toEqual(fileIds(file));

	const third = manager.appendMessage(user("third"));
	expect(fileIds(file), "the manager persisted it before the lane accepted it").toContain(third);
	const ahead = lane.freeze();
	expect(rootIds(ahead.transcript), "persisted but not accepted is beyond the cut").toEqual(fileIds(file).slice(0, 3));

	lane.applyTranscript(manager.drainTranscript());
	const accepted = lane.freeze();
	expect(accepted.sequence, "the append took its own sequence").toBe(ahead.sequence + 1);
	expect(accepted.transcript.historyVersion).toBe(ahead.transcript.historyVersion + 1);
	expect(rootIds(accepted.transcript)).toEqual(fileIds(file));

	manager.appendMessage(user("fourth"));
	lane.applyTranscript(manager.drainTranscript());
	expect(rootIds(accepted.transcript), "an earlier version never reads a later append").toEqual(
		fileIds(file).slice(0, 4),
	);
	expect(rootIds(ahead.transcript)).toEqual(fileIds(file).slice(0, 3));
	for (const root of [atBootstrap, ahead, accepted]) lane.release(root);
	expect(lane.liveRoots).toBe(0);
});

it("C1.1 branch and reset: each leaf move takes its own sequence and root version, and earlier roots keep their leaf", async () => {
	const { manager, lane, file } = await reopened();
	const [, firstId, secondId] = fileIds(file);
	const start = lane.freeze();
	expect(start.transcript.leafId).toBe(secondId);

	manager.branch(String(firstId));
	lane.applyTranscript(manager.drainTranscript());
	const branched = lane.freeze();
	expect(branched.transcript.leafId).toBe(firstId);
	expect(branched.sequence).toBe(start.sequence + 1);
	expect(branched.transcript.historyVersion).toBe(start.transcript.historyVersion + 1);

	manager.resetLeaf();
	lane.applyTranscript(manager.drainTranscript());
	const reset = lane.freeze();
	expect(reset.transcript.leafId).toBeNull();
	expect(reset.sequence).toBe(branched.sequence + 1);

	const rerooted = manager.appendMessage(user("a new root"));
	lane.applyTranscript(manager.drainTranscript());
	const after = lane.freeze();
	expect(after.transcript.leafId).toBe(rerooted);
	const read = readTranscriptRoot(after.transcript);
	expect(read.ok && read.entries.at(-1)).toMatchObject({ id: rerooted, parentId: null });
	expect(start.transcript.leafId, "earlier versions keep their own leaf").toBe(secondId);
	expect(branched.transcript.leafId).toBe(firstId);
	expect(reset.transcript.leafId).toBeNull();
});

// Part of #4272, ruling 10 Q3: the persisted base is read only through the identity captured at load.
it("Q3 rewritten: a base whose file was rewritten in place or replaced by rename is a typed failure, never a read of the new file", async () => {
	const { lane, file } = await reopened();
	const root = lane.freeze();
	const lines = readFileSync(file, "utf8").trim().split("\n");
	const renamed = lines.map((line) => {
		const entry = JSON.parse(line);
		return JSON.stringify(entry.type === "session" ? entry : { ...entry, id: `${entry.id}0` });
	});
	writeFileSync(file, `${renamed.join("\n")}\n`);
	expect(readTranscriptRoot(root.transcript), "same file, same count, other entries").toEqual({
		ok: false,
		error: "base_fingerprint_mismatch",
	});

	writeFileSync(`${file}.next`, `${lines.join("\n")}\n`);
	renameSync(`${file}.next`, file);
	expect(readTranscriptRoot(root.transcript), "the original bytes, but another file").toEqual({
		ok: false,
		error: "base_file_replaced",
	});
});

it("Q3 truncated: a base whose file was truncated under it is a typed failure, never a shorter read", async () => {
	const { lane, file } = await reopened();
	const root = lane.freeze();
	truncateSync(file, readFileSync(file, "utf8").indexOf("\n") + 1);
	expect(readTranscriptRoot(root.transcript)).toEqual({ ok: false, error: "base_file_truncated" });
});

it("C1.1 replacement roots: a branched session and a new session replace the root, and the replaced version still reads its own file", async () => {
	const { manager, lane, file } = await reopened();
	const before = lane.freeze();
	const [, , secondId] = fileIds(file);

	const forkFile = String(manager.createBranchedSession(String(secondId)));
	await manager.persistHeaderNow();
	lane.applyTranscript(manager.drainTranscript());
	const branched = lane.freeze();
	expect(branched.transcript.base?.fileIdentity.path, "the branched file is the new base").toBe(forkFile);
	expect(branched.transcript.count).toBe(0);
	expect(rootIds(branched.transcript)).toEqual(fileIds(forkFile));
	expect(rootIds(before.transcript), "the replaced version still reads the original file").toEqual(fileIds(file));

	manager.newSession();
	lane.applyTranscript(manager.drainTranscript());
	const fresh = lane.freeze();
	expect(fresh.transcript.base, "an unwritten session has no persisted base").toBeNull();
	expect(rootIds(fresh.transcript)).toEqual([manager.getSessionId()]);
	expect(rootIds(branched.transcript)).toEqual(fileIds(forkFile));
});
