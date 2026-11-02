import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadEntriesFromFile, loadEntriesFromFileAsync } from "../../../src/core/session-entry-file.ts";
import { loadedContentFingerprints } from "../../../src/core/session-file-identity.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import {
	type BaseEntry,
	baseRig,
	contentFingerprintOf,
	refusal,
	stampedBytes,
	writeBase,
} from "./4272-base-file-support.ts";

// Part of #4272 (S11c, RULING-72 = A): the load records a domain-separated SHA-256 content fingerprint over the exact
// lines it counted, in the read pass it already makes, and the base anchor carries it beside idFingerprint. The S11c
// open verifies it, so ANY change to the base since the load (ids or content, before or after the first page) is the
// typed base_fingerprint_mismatch.

let dir = "";
const managers: SessionManager[] = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "senpi-4272-base-content-"));
});

afterEach(async () => {
	for (const manager of managers.splice(0)) manager.dispose();
	vi.unstubAllEnvs();
	await rm(dir, { recursive: true, force: true });
});

const header = JSON.stringify({ type: "session", id: "s0", version: 3, timestamp: "t", cwd: "/w" });
const message = (id: string, parentId: string | null, text: string) =>
	JSON.stringify({ type: "message", id, parentId, timestamp: "t", message: { role: "user", content: text } });

it("RULING-72 (2) the loader fingerprints exactly the lines it counted in its one read pass, sync and async; a load without capture records none", async () => {
	// Given: a session file with a blank and a malformed line between entries and an unterminated final entry
	const path = join(dir, "s.jsonl");
	const counted = [header, message("e0", null, "hi"), message("e1", "e0", "there \u{1F600}")];
	await writeFile(path, `${counted[0]}\n${counted[1]}\n\n{torn\n${counted[2]}`);
	const expected = contentFingerprintOf(counted);
	// When: the file is loaded with the base capture on, synchronously and asynchronously
	const sync = loadEntriesFromFile(path, true);
	const async = await loadEntriesFromFileAsync(path, undefined, true);
	// Then: both record the fingerprint of the counted lines, the skipped ones excluded
	expect(sync).toHaveLength(3);
	expect(loadedContentFingerprints.get(sync)).toBe(expected);
	expect(loadedContentFingerprints.get(async)).toBe(expected);
	// And: a load without the capture (the compact flag off) records nothing
	expect(loadedContentFingerprints.get(loadEntriesFromFile(path))).toBeUndefined();
});

it("RULING-72 a session opened from disk, and one its own rewrite replaced, carries the content fingerprint on its base", async () => {
	// Given: the compact flag on and a session file on disk
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const path = join(dir, "s.jsonl");
	const lines = [header, message("e0", null, "hi"), message("e1", "e0", "there")];
	await writeFile(path, `${lines.join("\n")}\n`);
	const manager = SessionManager.open(path, dir);
	managers.push(manager);
	const baseOf = async () => {
		await manager["transcriptFile"].ready;
		const lane = new SessionAcceptanceLane();
		lane.bootstrap({ transcript: manager.beginTranscriptJournal() });
		const root = lane.freeze();
		const base = root.transcript.base;
		lane.release(root);
		return base;
	};
	// Then: the loaded base carries the fingerprint of the lines the load read
	expect((await baseOf())?.contentFingerprint).toBe(contentFingerprintOf(lines));
	// When: the manager rewrites its file
	manager["_rewriteFile"]();
	// Then: the new base carries the fingerprint of the lines the rewrite wrote
	const written = (await readFile(path, "utf8")).split("\n").filter(Boolean);
	expect((await baseOf())?.contentFingerprint).toBe(contentFingerprintOf(written));
});

const entries: readonly BaseEntry[] = [
	{ type: "session", id: "s0", version: 3 },
	{ type: "message", id: "e0", parentId: null, message: { role: "user", content: "hi" } },
	{ type: "message", id: "e1", parentId: "e0", message: { role: "assistant", content: [] } },
	{ type: "label", id: "e2", parentId: "e1", label: "note" },
];
const original = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
const reparented = original.replace('"id":"e2","parentId":"e1"', '"id":"e2","parentId":"e0"');

it("RULING-72 (3) the reviewer's probe: an in-place, same-inode, same-length edit of a parent before the first page is refused", async () => {
	// Given: a cut on a loaded base, and its file then edited in place before any page (same ids, same length)
	const path = join(dir, "s.jsonl");
	const base = await writeBase(path, entries);
	const { request, release } = await baseRig(base, "e2");
	expect(reparented.length).toBe(original.length);
	await writeFile(path, reparented);
	// Then: the first page is the typed mismatch, never the edited row
	expect(refusal(await request())).toEqual({ kind: "storage_unavailable", reason: "base_fingerprint_mismatch" });
	await release();
});

it("RULING-72 (3) an untouched file opens, and an edit after the open is still caught by the per-row check", async () => {
	// Given: a cut on a loaded base, untouched
	const path = join(dir, "s.jsonl");
	const base = await writeBase(path, entries);
	const { request, stream, release } = await baseRig(base, "e2");
	// Then: it streams byte-exact
	expect((await stream()).bytes.equals(stampedBytes(entries))).toBe(true);
	// When: the file is edited in place after the open (same ids, same length)
	await writeFile(path, reparented);
	// Then: the next page is refused by the per-row check
	expect(refusal(await request())).toEqual({ kind: "storage_unavailable", reason: "base_fingerprint_mismatch" });
	await release();
});
