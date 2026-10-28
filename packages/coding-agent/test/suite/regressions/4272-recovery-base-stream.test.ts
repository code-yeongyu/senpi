import { appendFile, mkdtemp, rename, rm, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FRAGMENT_MAX_BYTES } from "../../../src/modes/rpc/compact-recovery-bytes.ts";
import { RecoveryPageRequests } from "../../../src/modes/rpc/compact-recovery-requests.ts";
import {
	type BaseEntry,
	baseRig,
	fingerprintOf,
	refusal,
	stampedBytes,
	stampedRow,
	unwrap,
	writeBase,
} from "./4272-base-file-support.ts";
import { specDigest } from "./4272-frozen-bytes-support.ts";

// Part of #4272 (S11c, RULING-61 partial -> exact, RULING-70 (1) B): the loaded transcript base streams through the
// page route as ONE STAMPED ROW PER BASE ENTRY in the one UTF-16LE codec under the reserved ref `<catalogRoot>:base`,
// anchored by the cut's idFingerprint and file identity. The owner reads the file asynchronously, never at freeze,
// and a file that changed since the cut (replaced, truncated, missing or rewritten in place) is a typed refusal,
// never stale bytes, even after a page of it was already served.

let dir = "";

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "senpi-4272-base-"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await rm(dir, { recursive: true, force: true });
});

const entries: readonly BaseEntry[] = [
	{ type: "session", id: "s0", version: 3, timestamp: "t" },
	{ type: "message", id: "e0", parentId: null, timestamp: "t", message: { role: "user", content: "hi" } },
	{ type: "ext_timeline_group", id: "e1", parentId: "e0", group: { title: "g \u{1F600} \ud800" } },
	{ type: "label", id: "e2", parentId: "e1", label: "note" },
	{ type: "message", id: "e3", parentId: "e2", message: { role: "assistant", content: [] } },
];

it("RULING-70 (1) every base entry streams as one stamped row with its kind and family, byte-exact in the one codec, under the cut's reserved ref", async () => {
	// Given: an epoch bootstrapped on a loaded base of five entries of three families, one of an unknown kind
	const base = await writeBase(join(dir, "s.jsonl"), entries);
	const { stream, manifest, token, release } = await baseRig(base, "e3");
	// When: the base is paged through the request owner under `<catalogRoot>:base`
	const { answers, bytes } = await stream();
	// Then: the join is exactly one stamped row per entry in file order, each page digest-checked in the fragment domain
	expect(bytes.equals(stampedBytes(entries))).toBe(true);
	expect(answers).toHaveLength(1);
	expect(answers[0]).toMatchObject({
		token: token.id,
		componentRef: `${manifest.catalogRoot}:base`,
		ordinal: 1,
		offset: 0,
		length: bytes.length,
		complete: true,
	});
	expect(specDigest("fragment", bytes)).toBe(answers[0]?.digest);
	const rows = bytes.toString("utf16le").split("\n").filter(Boolean);
	expect(rows).toEqual(entries.map((entry, index) => stampedRow(index, entry).trimEnd()));
	expect(rows.map((row) => (JSON.parse(row) as { family: string }).family)).toEqual([
		"transcript",
		"transcript",
		"opaque",
		"source",
		"transcript",
	]);
	// And: the client re-derives the cut's anchor from the rows alone and it matches the catalog's idFingerprint
	const stamped = rows.map((row) => JSON.parse(row) as { kind: string; id: string });
	expect(fingerprintOf(stamped.map(({ kind, id }) => ({ type: kind, id })))).toBe(base.idFingerprint);
	await release();
});

it("RULING-59 a base over D pages at raw byte offsets through cursors; a blank and a malformed line are skipped as the loader skips them", async () => {
	// Given: a base whose stamped rows exceed one fragment, written with a blank line and a torn line among them
	const many: BaseEntry[] = [{ type: "session", id: "s0" }];
	for (let index = 1; index < 1_400; index++)
		many.push({ type: index % 7 === 0 ? "custom" : "message", id: `entry-${index}`, parentId: `entry-${index - 1}` });
	const raw = `${many.map((entry) => JSON.stringify(entry)).join("\n")}\n`.replace("\n", "\n\n{not json\n");
	const base = await writeBase(join(dir, "s.jsonl"), many, raw);
	const { stream, release } = await baseRig(base, "entry-1399");
	// When: every page is taken in cursor order
	const { answers, bytes } = await stream();
	// Then: the pages are D-sized at advancing offsets and ordinals, and the join is byte-exact
	const expected = stampedBytes(many);
	const pages = Math.ceil(expected.length / FRAGMENT_MAX_BYTES);
	expect(pages).toBeGreaterThanOrEqual(3);
	expect(answers.map((answer) => [answer.ordinal, answer.offset, answer.length, answer.complete])).toEqual(
		Array.from({ length: pages }, (_, index) => [
			index + 1,
			index * FRAGMENT_MAX_BYTES,
			Math.min(FRAGMENT_MAX_BYTES, expected.length - index * FRAGMENT_MAX_BYTES),
			index === pages - 1,
		]),
	);
	expect(bytes.equals(expected)).toBe(true);
	await release();
});

it("RULING-70 (1) a file that changed since the cut is a typed refusal, never stale bytes, even after a page was served", async () => {
	// Given: a base whose first page was already served (the stream is open and verified)
	const path = join(dir, "s.jsonl");
	const base = await writeBase(path, entries);
	const { request, rig, release } = await baseRig(base, "e3");
	unwrap(await request());
	const original = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	// When: the file is rewritten in place with one id changed (same inode, same length)
	await writeFile(path, original.replace('"id":"e2"', '"id":"e9"'));
	// Then: the next request is the typed mismatch, and the bytes already stamped are never served again
	expect(refusal(await request())).toEqual({ kind: "storage_unavailable", reason: "base_fingerprint_mismatch" });
	// When: the original bytes come back as another file at the same path
	await writeFile(`${path}.next`, original);
	await rename(`${path}.next`, path);
	expect(refusal(await request())).toEqual({ kind: "storage_unavailable", reason: "base_file_replaced" });
	// When: the file is gone
	await unlink(path);
	expect(refusal(await request())).toEqual({ kind: "storage_unavailable", reason: "base_file_missing" });
	expect(rig.checkpoints.status().unavailable).toEqual({
		base_fingerprint_mismatch: 1,
		base_file_replaced: 1,
		base_file_missing: 1,
	});
	await release();
});

it("RULING-70 (1) a base truncated under the cut, or shorter than its count at open, is the typed truncation; a legal append after it is never read", async () => {
	// Given: a base of five entries, with a sixth appended after the cut (legal: beyond the count)
	const path = join(dir, "s.jsonl");
	const base = await writeBase(path, entries);
	const first = await baseRig(base, "e3");
	await appendFile(path, `${JSON.stringify({ type: "message", id: "e4", parentId: "e3" })}\n`);
	// When: the base is streamed
	// Then: exactly the five rows of the cut
	expect((await first.stream()).bytes.equals(stampedBytes(entries))).toBe(true);
	// When: the file is truncated inside the base
	await truncate(path, original(entries).indexOf('{"type":"label"'));
	expect(refusal(await first.request())).toEqual({ kind: "storage_unavailable", reason: "base_file_truncated" });
	await first.release();
	// And: a fresh cut on the truncated file refuses at open, before any row is served
	const second = await baseRig(base, "e3");
	expect(refusal(await second.request())).toEqual({ kind: "storage_unavailable", reason: "base_file_truncated" });
	await second.release();
});

const original = (lines: readonly BaseEntry[]): string => `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

it("RULING-58 (3) the reserved ref is cut-scoped: another cut's base ref, a root without a base, a node read and a malformed step are range refusals before any file read", async () => {
	// Given: a cut on a loaded base whose file is then deleted, so any read before the refusal would surface as missing
	const path = join(dir, "s.jsonl");
	const base = await writeBase(path, entries);
	const withBase = await baseRig(base, "e3");
	await unlink(path);
	const range = { kind: "storage_unavailable", reason: "range" };
	// Then: a base ref under another catalog root names nothing under this token
	expect(refusal(await withBase.request({ componentRef: "c-0000000000000099:base" }))).toEqual(range);
	expect(refusal(await withBase.request({ componentRef: `${withBase.manifest.catalogRoot}:000:base` }))).toEqual(
		range,
	);
	expect(refusal(await withBase.request({ componentRef: `${withBase.manifest.catalogRoot}:BASE` }))).toEqual(range);
	// And: the catalog read route never serves it (the base is pages only)
	const read = await withBase.rig.checkpoints.readCatalog(
		withBase.token,
		withBase.caller,
		`${withBase.manifest.catalogRoot}:base`,
	);
	expect(read.ok ? undefined : read.failure).toEqual(range);
	expect(withBase.rig.checkpoints.status().unavailable, "four range refusals, no missing-file one").toEqual({
		range: 4,
	});
	await withBase.release();
	// And: a root with no loaded base has no base stream
	const fresh = await baseRig({ ...base, count: 0 }, "e3");
	expect(refusal(await fresh.request({ componentRef: `${fresh.manifest.catalogRoot}:base` }))).toEqual(range);
	expect(fresh.rig.checkpoints.status().unavailable, "every refusal was range, none reached the file").toEqual({
		range: 1,
	});
	await fresh.release();
});

it("RULING-69 (2) the base is verified once per frozen root inside the request's budget: an abort mid-scan caches nothing, a later open is cached and dies with the lease", async () => {
	// Given: a cut on a loaded base, and a request whose budget is already spent
	const base = await writeBase(join(dir, "s.jsonl"), entries);
	const { rig, caller, token, manifest, release } = await baseRig(base, "e3");
	const pages = new RecoveryPageRequests(rig.checkpoints);
	const first = {
		requestId: "a-1",
		admissionId: token.admission.admissionId,
		token: token.id,
		componentRef: `${manifest.catalogRoot}:base`,
	};
	const spent = AbortSignal.abort();
	// When: the open runs under it
	// Then: it is the typed abort and nothing is verified or cached
	expect(refusal(await pages.request(caller, first, spent))).toEqual({
		kind: "storage_unavailable",
		reason: "aborted",
	});
	expect(rig.checkpoints.verifiedComponents).toBe(0);
	// When: the next request opens it for real, and a third pages it again
	unwrap(await pages.request(caller, { ...first, requestId: "a-2" }));
	expect(rig.checkpoints.verifiedComponents, "the verified base stream is cached on its root").toBe(1);
	unwrap(await pages.request(caller, { ...first, requestId: "a-3" }));
	expect(rig.checkpoints.verifiedComponents).toBe(1);
	// Then: the entry goes with the token's lease
	await release();
	expect(rig.checkpoints.verifiedComponents).toBe(0);
});
