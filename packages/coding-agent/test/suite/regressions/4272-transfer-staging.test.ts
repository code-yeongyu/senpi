import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from "vitest";
import {
	type CatalogEntry,
	CatalogNodeWriter,
	decodeCatalogNode,
} from "../../../src/modes/rpc/compact-catalog-codec.ts";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { CompactReadError } from "../../../src/modes/rpc/compact-read-lease.ts";
import { FRAGMENT_MAX_BYTES } from "../../../src/modes/rpc/compact-recovery-bytes.ts";
import { protocolId } from "../../../src/modes/rpc/compact-recovery-ids.ts";
import {
	type FrozenRef,
	TRANSFER_STAGING_MAX_BYTES,
	TransferStaging,
	TransferStagingError,
} from "../../../src/modes/rpc/compact-transfer-staging.ts";

// Part of #4272 (S12a, RULING-46 item 2, RULING-63 Q2): the shared bounded staging/ref substrate S12b and S13 reuse.

const KIND = protocolId("staged");
const ID = protocolId("value-1");
let dir = "";
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "senpi-4272-staging-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(dir, { recursive: true, force: true });
});

const staging = (options: { spill?: boolean; maxBytes?: number } = {}) => {
	const store = new CompactContentStore({
		dir: join(dir, "spool"),
		...(options.spill ? { spillAboveBytes: 0, spillTargetBytes: 0 } : {}),
	});
	return { store, staging: new TransferStaging(store, options.maxBytes) };
};

const released = { stagedBytes: 0, openTransfers: 0, residentPayloadBytes: 0 };

const refusal = (run: () => unknown): string => {
	try {
		run();
	} catch (cause) {
		if (cause instanceof TransferStagingError) return cause.reason;
		if (cause instanceof CompactReadError) return cause.reason;
		throw cause;
	}
	throw new Error("expected a refusal");
};

/** The S11a leaf digest, computed here from its definition, not through the codec under test. */
const leafDigest = (bytes: Buffer): string => {
	const tag = Buffer.from("senpi-recovery-catalog/1/utf16le/leaf", "ascii");
	const length = Buffer.alloc(8);
	length.writeBigUInt64BE(BigInt(bytes.length));
	return createHash("sha256")
		.update(Buffer.concat([Buffer.from([tag.length]), tag, length, bytes]))
		.digest("hex");
};

// A pair straddling the first leaf boundary (32,768 units) and one straddling the first fragment boundary (65,536).
const SPLIT_TEXT = `${"a".repeat(32_767)}😀${"b".repeat(32_766)}😀${"c".repeat(1000)}`;

it("S12a X04: begin over the staging bound refuses before any leaf exists, and the default bound is B_worker", () => {
	expect(TRANSFER_STAGING_MAX_BYTES).toBe(67_108_864);
	const create = vi.spyOn(CompactContentStore.prototype, "createLeaf");
	const { staging: owner } = staging({ maxBytes: 1024 });
	expect(refusal(() => owner.begin(KIND, ID, 1026))).toBe("staging_over_byte_limit");
	const first = owner.begin(KIND, ID, 600);
	expect(owner.status().stagedBytes, "the whole declared length is reserved up front").toBe(600);
	expect(refusal(() => owner.begin(KIND, ID, 600))).toBe("staging_over_byte_limit");
	expect(create).not.toHaveBeenCalled();
	first.abort();
	expect(owner.status()).toMatchObject(released);
});

it("S12a X04: every failure path releases what a transfer staged", async () => {
	const { store, staging: owner } = staging();
	const over = owner.begin(KIND, ID, 400_000);
	over.append("x".repeat(1000));
	expect(
		refusal(() => over.append("x".repeat(FRAGMENT_MAX_BYTES / 2 + 1))),
		"a fragment over D",
	).toBe("fragment_over_limit");
	expect(owner.status()).toMatchObject(released);
	const overrun = owner.begin(KIND, ID, 10);
	expect(
		refusal(() => overrun.append("abcdef")),
		"past the declared length",
	).toBe("length_mismatch");
	expect(owner.status()).toMatchObject(released);
	const short = owner.begin(KIND, ID, 10);
	short.append("ab");
	expect(
		refusal(() => short.commit()),
		"short of the declared length",
	).toBe("length_mismatch");
	expect(owner.status()).toMatchObject(released);
	expect(
		refusal(() => short.append("ab")),
		"a closed transfer",
	).toBe("staging_closed");
	expect(
		refusal(() => owner.begin(KIND, ID, 3)),
		"an odd stored length",
	).toBe("length_mismatch");
	const aborted = owner.begin(KIND, ID, 10);
	aborted.append("abc");
	aborted.abort();
	aborted.abort();
	expect(refusal(() => aborted.commit())).toBe("staging_closed");
	expect(owner.status()).toMatchObject(released);
	const midway = owner.begin(KIND, ID, 20);
	midway.append("abcde");
	await store.retire();
	expect(
		refusal(() => midway.append("abcde")),
		"the store retired mid-transfer",
	).toBe("retired");
	expect(owner.status()).toMatchObject(released);
});

it("S12a X04: adopt moves bytes out of the staging bound; close aborts open transfers and releases content never adopted", async () => {
	const { staging: owner } = staging();
	const open = owner.begin(KIND, ID, 40);
	open.append("0123456789");
	const loose = owner.stage(KIND, ID, "loose");
	const kept = owner.stage(KIND, ID, "kept");
	expect(owner.status().stagedBytes).toBe(40 + 10 + 8);
	owner.adopt(kept);
	expect(owner.status()).toMatchObject({ stagedBytes: 50, residentPayloadBytes: 20 + 10 + 8 });
	owner.abandon(kept);
	expect(owner.status().residentPayloadBytes, "abandon never touches adopted content").toBe(38);
	await owner.close();
	expect(owner.status()).toMatchObject({ stagedBytes: 0, openTransfers: 0, residentPayloadBytes: 8 });
	expect(refusal(() => owner.begin(KIND, ID, 2))).toBe("staging_closed");
	owner.release(kept);
	expect(owner.status().residentPayloadBytes).toBe(0);
	expect(loose.ref.entry.length).toBe(10);
});

it("S12a RULING-63 Q2(1): a staged ref round-trips through the S11a catalog codec byte-identically and opens digest-verified", async () => {
	const { staging: owner } = staging();
	const content = owner.stage(KIND, ID, SPLIT_TEXT);
	const stored = Buffer.from(SPLIT_TEXT, "utf16le");
	expect(content.ref).toEqual({
		variant: "staged",
		entry: { kind: KIND, id: ID, length: stored.length, digest: leafDigest(stored) },
	});
	const writer = new CatalogNodeWriter();
	expect(writer.push(content.ref.entry)).toBe(true);
	const encoded = writer.encode();
	expect(encoded).toBe(
		`{"format":"senpi-recovery-catalog","version":1,"entries":[{"kind":"staged","id":"value-1","length":${stored.length},"digest":"${leafDigest(stored)}"}]}`,
	);
	const decoded = decodeCatalogNode(encoded);
	expect(decoded).toEqual({ ok: true, entries: [content.ref.entry] });
	const again = new CatalogNodeWriter();
	if (!decoded.ok) throw new Error("decoded");
	again.push(decoded.entries[0] as CatalogEntry);
	expect(again.encode(), "no second encoder: the decoded ref encodes to the same bytes").toBe(encoded);
	const bytes = await owner.open(content);
	expect(bytes.digest).toBe(leafDigest(stored));
	expect(await bytes.range(0, FRAGMENT_MAX_BYTES)).toEqual(stored.subarray(0, FRAGMENT_MAX_BYTES));
	expect(await bytes.range(FRAGMENT_MAX_BYTES, stored.length - FRAGMENT_MAX_BYTES)).toEqual(
		stored.subarray(FRAGMENT_MAX_BYTES),
	);
	const chunks: string[] = [];
	for await (const chunk of owner.chunks(content)) chunks.push(chunk);
	expect(chunks.every((chunk) => chunk.length * 2 <= FRAGMENT_MAX_BYTES)).toBe(true);
	expect(chunks.join("")).toBe(SPLIT_TEXT);
});

it("S12a T5: spilled staged content reads back byte-identical under a pin; a tampered spool file is a typed integrity error", async () => {
	const { store, staging: owner } = staging({ spill: true });
	const content = owner.stage(KIND, ID, SPLIT_TEXT);
	owner.adopt(content);
	await store.idle();
	expect(owner.status()).toMatchObject({ residentPayloadBytes: 0, spilledLiveBytes: SPLIT_TEXT.length * 2 });
	owner.pin(content, 1);
	owner.release(content);
	let read = "";
	for await (const chunk of owner.chunks(content)) read += chunk;
	expect(read, "a pinned read outlives the owner's release").toBe(SPLIT_TEXT);
	const files = await readdir(join(dir, "spool"));
	const file = join(dir, "spool", files.filter((name) => name.startsWith("leaf-")).sort()[0] ?? "");
	const data = await readFile(file);
	data[0] = (data[0] ?? 0) ^ 1;
	await writeFile(file, data);
	await expect(owner.open(content)).rejects.toMatchObject({ reason: "integrity" });
	owner.pin(content, -1);
	await store.idle();
	expect(owner.status()).toMatchObject({ residentPayloadBytes: 0, spilledLiveBytes: 0 });
});

it("S12a RULING-63 Q2(2): the staged variant keeps its shape, so a later variant can only extend the union", () => {
	expectTypeOf<Extract<FrozenRef, { variant: "staged" }>>().toEqualTypeOf<{
		readonly variant: "staged";
		readonly entry: CatalogEntry;
	}>();
});
