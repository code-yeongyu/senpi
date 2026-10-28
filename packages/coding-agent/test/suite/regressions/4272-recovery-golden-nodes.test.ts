import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import {
	type CatalogEntry,
	catalogDigest,
	decodeCatalogNode,
	storedBytes,
} from "../../../src/modes/rpc/compact-catalog-codec.ts";
import { parseContentDigest, protocolId } from "../../../src/modes/rpc/compact-recovery-ids.ts";
import { specDigest } from "./4272-frozen-bytes-support.ts";
import { committedGoldens, PACKAGE_ROOT, readGolden } from "./4272-recovery-golden-files.ts";
import {
	CATALOG_NODE_DIRECTORY,
	flipOneByte,
	type NodeGolden,
	produceCatalogNodeGoldens,
	produceNode,
	S09A_GOLDEN_ENTRIES,
} from "./4272-recovery-golden-nodes.ts";
import { RECOVERY_PAGE_DIRECTORY } from "./4272-recovery-golden-pages.ts";

// Part of #4272 (SF2, desktop RULING-68/68a, R4.B2, RULING-57/58): the shared catalog-node goldens the desktop decoder
// (D04) tests against, each carrying the digest S09a's real digest function computes over the exact stored bytes. The
// desktop verifies that digest before decoding and fails closed on a mismatch (the node-digest-mismatch case).

interface NodeCase {
	readonly caseId: string;
	readonly input: { readonly entries: readonly RawEntry[]; readonly components?: readonly ComponentInput[] };
	readonly expected: NodeGolden;
}
interface RawEntry {
	readonly kind: string;
	readonly id: string;
	readonly length: number;
	readonly digest: string;
}
interface ComponentInput {
	readonly storedBytes: string;
	readonly length: number;
	readonly digest: string;
}
interface MismatchCase {
	readonly input: { readonly storedBytes: string; readonly length: number; readonly declaredDigest: string };
	readonly fault: { readonly byteOffset: number; readonly xor: number; readonly actualDigest: string };
	readonly expectedOutcome: string;
}

const NODE_CASES = ["leaf-node", "node-with-children"] as const;
/** S09a's pinned node digest (`4272-recovery-catalog-codec.test.ts` GOLDEN_NODE_DIGEST), restated as the cross-check. */
const S09A_GOLDEN_NODE_DIGEST = "fa1de8cdae098d7eb81dfdda48b25efc90103c0411f11f69f8a2946fb050e794";

const toEntry = ({ kind, id, length, digest }: RawEntry): CatalogEntry => {
	const parsed = parseContentDigest(digest);
	if (!parsed.ok) throw new Error(`golden entry digest ${parsed.reason}`);
	return { kind: protocolId(kind), id: protocolId(id), length, digest: parsed.value };
};

const readNode = (caseId: string): NodeCase => readGolden<NodeCase>(CATALOG_NODE_DIRECTORY, `${caseId}.json`);

it("SF2 the committed catalog-node files are byte-identical to the real codec's output and nothing else is there", () => {
	const generated = produceCatalogNodeGoldens();
	const committed = committedGoldens(CATALOG_NODE_DIRECTORY, generated);
	expect([...committed.keys()]).toEqual([...generated.keys()].sort());
	for (const [name, content] of generated) expect(committed.get(name), name).toBe(content);
});

it.each(NODE_CASES)("SF2 %s: the real node codec emits exactly the golden stored bytes and digests", (caseId) => {
	const golden = readNode(caseId);
	const produced = produceNode(golden.input.entries.map(toEntry));
	expect(JSON.stringify(produced)).toBe(JSON.stringify(golden.expected));
	const bytes = Buffer.from(golden.expected.storedBytes, "base64");
	expect(bytes.equals(storedBytes(produced.text))).toBe(true);
	expect(bytes.length).toBe(golden.expected.length);
	expect(bytes.toString("utf16le")).toBe(golden.expected.text);
	expect(catalogDigest("node", bytes), "the producer's digest of the golden bytes").toBe(golden.expected.digest);
	expect(catalogDigest("root", bytes)).toBe(golden.expected.rootDigest);
	expect(specDigest("node", bytes), "the digest rule in index.json, applied independently").toBe(
		golden.expected.digest,
	);
	expect(specDigest("root", bytes)).toBe(golden.expected.rootDigest);
	expect(decodeCatalogNode(golden.expected.text)).toEqual({ ok: true, entries: golden.input.entries });
});

it("SF2 node-with-children is S09a's golden node: the same bytes and the same pinned digest", () => {
	const { input, expected: golden } = readNode("node-with-children");
	expect(input.entries.map(toEntry)).toEqual(S09A_GOLDEN_ENTRIES);
	expect(golden.digest).toBe(S09A_GOLDEN_NODE_DIGEST);
	expect(golden.length).toBe(642);
	const decoded = decodeCatalogNode(golden.text);
	expect(decoded.ok && decoded.entries.map((entry) => entry.kind)).toEqual(["lifecycle", "node"]);
});

it("SF2 leaf-node: every entry names its component's exact stored bytes by length and leaf digest", () => {
	const golden = readNode("leaf-node");
	const components = golden.input.components ?? expect.unreachable("the leaf node lists its components");
	expect(golden.input.entries).toHaveLength(components.length);
	for (const [index, component] of components.entries()) {
		const bytes = Buffer.from(component.storedBytes, "base64");
		expect(bytes.length).toBe(component.length);
		expect(specDigest("leaf", bytes)).toBe(component.digest);
		expect(golden.input.entries[index]).toMatchObject({ length: component.length, digest: component.digest });
	}
	const message = Buffer.from(components[1]?.storedBytes ?? "", "base64");
	expect(message.subarray(-10, -8).equals(Buffer.from([0x3d, 0xd8])), "the lone surrogate is stored as is").toBe(true);
});

it("SF2 desktop fail-closed case: one flipped byte still decodes, yet its digest no longer matches the declared one", () => {
	const golden = readNode("node-with-children").expected;
	const mismatch = readGolden<MismatchCase>(CATALOG_NODE_DIRECTORY, "node-digest-mismatch.json");
	const flipped = Buffer.from(mismatch.input.storedBytes, "base64");
	const original = Buffer.from(golden.storedBytes, "base64");
	expect(flipped.length).toBe(original.length);
	expect(mismatch.input).toMatchObject({ length: original.length, declaredDigest: golden.digest });
	const differing = [...flipped.keys()].filter((index) => flipped[index] !== original[index]);
	expect(differing).toEqual([mismatch.fault.byteOffset]);
	expect((flipped[mismatch.fault.byteOffset] ?? 0) ^ (original[mismatch.fault.byteOffset] ?? 0)).toBe(0x01);
	expect(flipOneByte(golden).bytes.equals(flipped)).toBe(true);
	const actual = catalogDigest("node", flipped);
	expect(actual).toBe(mismatch.fault.actualDigest);
	expect(actual).not.toBe(mismatch.input.declaredDigest);
	expect(mismatch.expectedOutcome).toBe("refuse_before_decode");
	const decoded = decodeCatalogNode(flipped.toString("utf16le"));
	expect(decoded.ok && decoded.entries[0]?.length, "only the digest catches it: the text decodes (42 -> 43)").toBe(43);
});

// Runs the real packer rather than re-implementing npm's files rules, so the check follows npm.
it("SF2 npm pack ships every recovery-page and catalog-node golden", () => {
	const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: PACKAGE_ROOT,
		encoding: "utf8",
		shell: process.platform === "win32",
	});
	const packed = new Set((JSON.parse(output)[0].files as { path: string }[]).map((entry) => entry.path));
	const expected = [
		...["index.json", "first-page.json", "middle-page.json", "last-page.json", "cursor-out-of-range.json"].map(
			(name) => `${RECOVERY_PAGE_DIRECTORY}/${name}`,
		),
		...["index.json", "leaf-node.json", "node-with-children.json", "node-digest-mismatch.json"].map(
			(name) => `${CATALOG_NODE_DIRECTORY}/${name}`,
		),
	];
	expect(expected.filter((path) => !packed.has(path))).toEqual([]);
}, 60_000);
