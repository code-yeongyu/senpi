import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { loadEntriesFromFile } from "../../../src/core/session-entry-file.ts";
import { loadedContentFingerprints } from "../../../src/core/session-file-identity.ts";
import { captureTranscriptBase, type PersistedBase } from "../../../src/core/session-transcript-journal.ts";
import { openBaseBytes } from "../../../src/modes/rpc/compact-recovery-base.ts";
import { producePage } from "../../../src/modes/rpc/compact-recovery-bytes.ts";
import { fingerprintOf } from "./4272-base-file-support.ts";

// Part of #4272 (S11c, review LOW2 of #4598): the base scan reads a session file exactly as the loader does, so every
// base the loader accepts streams. A parsed line that is no session entry (or a legacy entry without ids) is a row
// like any other, retained as RULING-60 Q1 (2) requires, never a refusal; its rows still re-derive idFingerprint.

let dir = "";

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "senpi-4272-base-parity-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** The base exactly as a load captures it: the loader's own entries, count and fingerprint. */
async function loadedBase(lines: readonly string[]): Promise<PersistedBase> {
	const path = join(dir, "s.jsonl");
	await writeFile(path, `${lines.join("\n")}\n`);
	const entries = loadEntriesFromFile(path, true);
	expect(entries.length, "the loader accepts the file").toBeGreaterThan(0);
	const identity = await stat(path, { bigint: true });
	const { count, idFingerprint } = captureTranscriptBase(entries);
	const contentFingerprint = loadedContentFingerprints.get(entries) ?? expect.unreachable("a capturing load");
	const fileIdentity = { path, dev: String(identity.dev), ino: String(identity.ino) };
	return { fileIdentity, count, idFingerprint, contentFingerprint };
}

async function rowsOf(base: PersistedBase): Promise<Record<string, unknown>[]> {
	const bytes = await openBaseBytes(base, () => undefined);
	const pages: Buffer[] = [];
	for (let offset: number | null = 0; offset !== null;) {
		const page = await producePage(bytes, offset);
		pages.push(page.bytes);
		offset = page.next;
	}
	const text = Buffer.concat(pages).toString("utf16le");
	return text
		.split("\n")
		.filter(Boolean)
		.map((row) => JSON.parse(row) as Record<string, unknown>);
}

const row = (index: number, id: string, parentId: string | null, kind: string, family: string) => ({
	index,
	id,
	source: "file",
	parentId,
	kind,
	family,
});

it("review LOW2 a parsable line that is no session entry streams as an opaque row, as the loader counted it, never a refusal", async () => {
	// Given: a session whose file holds parsable non-entry lines among its entries (and falsy values the loader skips)
	const base = await loadedBase([
		JSON.stringify({ type: "session", id: "s0", version: 3 }),
		JSON.stringify({ type: "message", id: "e0", parentId: null, message: { role: "user", content: "hi" } }),
		JSON.stringify({ note: "not an entry" }),
		"[1,2]",
		"7",
		'"text"',
		"0",
		"null",
		JSON.stringify({ type: "message", id: "e1", parentId: { nested: true } }),
	]);
	expect(base.count, "the loader keeps every truthy parsed value").toBe(7);
	// When: the base is streamed
	const rows = await rowsOf(base);
	// Then: one row per loaded entry; the non-entries are retained as opaque rows with the loader's string forms
	expect(rows).toEqual([
		row(0, "s0", null, "session", "transcript"),
		row(1, "e0", null, "message", "transcript"),
		row(2, "undefined", null, "undefined", "opaque"),
		row(3, "undefined", null, "undefined", "opaque"),
		row(4, "undefined", null, "undefined", "opaque"),
		row(5, "undefined", null, "undefined", "opaque"),
		row(6, "e1", null, "message", "transcript"),
	]);
	// And: the rows re-derive the catalog's idFingerprint, as the client's anchor check does
	expect(fingerprintOf(rows.map((stamped) => ({ type: String(stamped.kind), id: String(stamped.id) })))).toBe(
		base.idFingerprint,
	);
});

it("review LOW2 a legacy pre-v3 file the loader accepts (entries without ids) streams its rows", async () => {
	// Given: a version-1 session file: a header without version, messages without id or parentId
	const base = await loadedBase([
		JSON.stringify({ type: "session", id: "legacy", timestamp: "t", cwd: "/w" }),
		JSON.stringify({ type: "message", timestamp: "t", message: { role: "user", content: "hi" } }),
		JSON.stringify({ type: "message", timestamp: "t", message: { role: "assistant", content: [] } }),
	]);
	// When: the base is streamed
	const rows = await rowsOf(base);
	// Then: every entry is a row, its missing id in the loader's string form, its family from its kind
	expect(rows).toEqual([
		row(0, "legacy", null, "session", "transcript"),
		row(1, "undefined", null, "message", "transcript"),
		row(2, "undefined", null, "message", "transcript"),
	]);
	expect(fingerprintOf(rows.map((stamped) => ({ type: String(stamped.kind), id: String(stamped.id) })))).toBe(
		base.idFingerprint,
	);
});
