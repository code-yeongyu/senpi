import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
	CATALOG_FORMAT,
	CATALOG_NODE_MAX_UNITS,
	CATALOG_VERSION,
	type CatalogEntry,
	CatalogNodeWriter,
	catalogDigest,
	decodeCatalogNode,
	storedBytes,
} from "../../../src/modes/rpc/compact-catalog-codec.ts";
import { COMPACT_LEAF_CODE_UNITS } from "../../../src/modes/rpc/compact-content-store.ts";
import {
	CATALOG_NODE_MAX_ENTRIES,
	type ContentDigest,
	parseContentDigest,
	protocolId,
} from "../../../src/modes/rpc/compact-recovery-ids.ts";

// Part of #4272 (S09, RULING-57 Q1): SHA-256 over the exact stored bytes under a length-prefixed, per-kind domain
// tag; node bytes deterministic by construction. Every expected digest here is computed from the written spec
// (`compact-catalog-codec.ts` header), never taken from the encoder under test.

const specDigest = (domain: "leaf" | "node" | "root", bytes: Buffer): string => {
	const tag = Buffer.from(`${CATALOG_FORMAT}/${CATALOG_VERSION}/${domain}`, "ascii");
	const length = Buffer.alloc(8);
	length.writeBigUInt64BE(BigInt(bytes.length));
	return createHash("sha256")
		.update(Buffer.from([tag.length]))
		.update(tag)
		.update(length)
		.update(bytes)
		.digest("hex");
};

const digest = (hex: string): ContentDigest => {
	const parsed = parseContentDigest(hex);
	if (!parsed.ok) throw new Error(parsed.reason);
	return parsed.value;
};

const golden: readonly CatalogEntry[] = [
	{ kind: protocolId("lifecycle"), id: protocolId("lifecycle"), length: 42, digest: digest("00".repeat(32)) },
	{
		kind: protocolId("node"),
		id: protocolId("node-0000000000000001"),
		length: 70_000,
		digest: digest("ff".repeat(32)),
	},
];
const GOLDEN_TEXT =
	'{"format":"senpi-recovery-catalog","version":1,"entries":[{"kind":"lifecycle","id":"lifecycle","length":42,"digest":"' +
	"00".repeat(32) +
	'"},{"kind":"node","id":"node-0000000000000001","length":70000,"digest":"' +
	"ff".repeat(32) +
	'"}]}';
const GOLDEN_NODE_DIGEST = "4e2ee6fc0072903974dff45a8439fdd917ef7f70a6a814a590d9c28f8fefc107";

it("RULING-57 Q1 (2) golden bytes: one node's encoding and digest are pinned; the stored bytes are the UTF-16LE text", () => {
	const writer = new CatalogNodeWriter();
	for (const entry of golden) expect(writer.push(entry)).toBe(true);
	const text = writer.encode();
	expect(text).toBe(GOLDEN_TEXT);
	expect(storedBytes(text).length).toBe(642);
	expect(storedBytes(text).equals(Buffer.from(GOLDEN_TEXT, "utf16le"))).toBe(true);
	expect(catalogDigest("node", storedBytes(text))).toBe(GOLDEN_NODE_DIGEST);
	expect(specDigest("node", storedBytes(text))).toBe(GOLDEN_NODE_DIGEST);
	expect(new CatalogNodeWriter().encode()).toBe('{"format":"senpi-recovery-catalog","version":1,"entries":[]}');
	expect(decodeCatalogNode(text)).toEqual({ ok: true, entries: golden });
});

it("RULING-57 Q1 (1) domain separation: the same bytes digested as leaf, node and root give three different digests, each per spec", () => {
	const bytes = storedBytes(GOLDEN_TEXT);
	const asLeaf = catalogDigest("leaf", bytes);
	const asNode = catalogDigest("node", bytes);
	const asRoot = catalogDigest("root", bytes);
	expect(new Set([asLeaf, asNode, asRoot]).size).toBe(3);
	expect(asLeaf).toBe(specDigest("leaf", bytes));
	expect(asRoot).toBe(specDigest("root", bytes));
	// The length prefix separates a payload from its own prefix: an empty payload has a non-trivial digest.
	expect(catalogDigest("leaf", Buffer.alloc(0))).toBe(specDigest("leaf", Buffer.alloc(0)));
	expect(catalogDigest("leaf", Buffer.alloc(0))).toBe(
		"f74d0a448927f4688580b5e6c03d136d77259ae29ff327694e7603fba8ef641f",
	);
});

it("RULING-57 Q1 (2) the writer is capped by construction: 128 entries, and the leaf bound before the 128th when entries are wide", () => {
	const wide: CatalogEntry = {
		kind: protocolId("k".repeat(128)),
		id: protocolId("i".repeat(128)),
		length: Number.MAX_SAFE_INTEGER,
		digest: digest("ab".repeat(32)),
	};
	const narrow: CatalogEntry = {
		kind: protocolId("k"),
		id: protocolId("i"),
		length: 0,
		digest: digest("ab".repeat(32)),
	};
	const byWidth = new CatalogNodeWriter();
	let accepted = 0;
	while (byWidth.push(wide)) accepted++;
	expect(accepted).toBeLessThan(CATALOG_NODE_MAX_ENTRIES);
	expect(byWidth.encode().length).toBeLessThanOrEqual(CATALOG_NODE_MAX_UNITS);
	expect(CATALOG_NODE_MAX_UNITS).toBe(COMPACT_LEAF_CODE_UNITS);
	const byCount = new CatalogNodeWriter();
	accepted = 0;
	while (byCount.push(narrow)) accepted++;
	expect(accepted).toBe(CATALOG_NODE_MAX_ENTRIES);
	expect(byCount.count).toBe(128);
	const decoded = decodeCatalogNode(byCount.encode());
	expect(decoded.ok && decoded.entries.length).toBe(128);
});

it.each([
	["not JSON", "{"],
	["an unknown format", GOLDEN_TEXT.replace("senpi-recovery-catalog", "other")],
	["a foreign version", GOLDEN_TEXT.replace('"version":1', '"version":2')],
	["an uppercase digest", GOLDEN_TEXT.replace("ff".repeat(32), "FF".repeat(32))],
	["a path in an id", GOLDEN_TEXT.replace('"id":"lifecycle"', '"id":"../x"')],
	["an extra field", GOLDEN_TEXT.replace('"entries"', '"extra":1,"entries"')],
	["a negative length", GOLDEN_TEXT.replace('"length":42', '"length":-1')],
	["a fractional length", GOLDEN_TEXT.replace('"length":42', '"length":4.5')],
])("RULING-57 Q2 (1) decoding refuses %s as a schema failure", (_label, text) => {
	expect(decodeCatalogNode(text)).toEqual({ ok: false, reason: "schema" });
});
