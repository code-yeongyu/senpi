import {
	type CatalogEntry,
	CatalogNodeWriter,
	catalogDigest,
	storedBytes,
} from "../../../src/modes/rpc/compact-catalog-codec.ts";
import { type ContentDigest, parseContentDigest, protocolId } from "../../../src/modes/rpc/compact-recovery-ids.ts";
import { REGENERATE, serialize } from "./4272-recovery-golden-files.ts";

export const CATALOG_NODE_DIRECTORY = "docs/engine-socket/fixtures/catalog-node";

const digest = (hex: string): ContentDigest => {
	const parsed = parseContentDigest(hex);
	if (!parsed.ok) throw new Error(parsed.reason);
	return parsed.value;
};

/** S09a's pinned golden node (`4272-recovery-catalog-codec.test.ts`): one component and one child of kind `node`. */
export const S09A_GOLDEN_ENTRIES: readonly CatalogEntry[] = [
	{ kind: protocolId("lifecycle"), id: protocolId("lifecycle"), length: 42, digest: digest("00".repeat(32)) },
	{
		kind: protocolId("node"),
		id: protocolId("node-0000000000000001"),
		length: 70_000,
		digest: digest("ff".repeat(32)),
	},
];

const LEAF_COMPONENTS = [
	{ kind: "lifecycle", id: "lifecycle", text: '{"state":"idle"}' },
	{ kind: "message", id: "m-0000000000000001", text: "h\u00e9llo \u{1F600} lone \ud83d end" },
] as const;

export interface NodeGolden {
	readonly text: string;
	readonly storedBytes: string;
	readonly length: number;
	readonly digest: string;
	readonly rootDigest: string;
}

export interface NodeDigestMismatch {
	readonly caseId: "node-digest-mismatch";
	readonly input: { readonly storedBytes: string; readonly length: number; readonly declaredDigest: string };
	readonly fault: { readonly byteOffset: number; readonly xor: number; readonly actualDigest: string };
}

export function produceNode(entries: readonly CatalogEntry[]): NodeGolden {
	const writer = new CatalogNodeWriter();
	for (const entry of entries) if (!writer.push(entry)) throw new Error("a golden entry did not fit the node");
	const text = writer.encode();
	const bytes = storedBytes(text);
	return {
		text,
		storedBytes: bytes.toString("base64"),
		length: bytes.length,
		digest: catalogDigest("node", bytes),
		rootDigest: catalogDigest("root", bytes),
	};
}

/** One byte of the golden's stored bytes XOR 0x01: the digit of `"length":42`, so the node still decodes (43). */
export function flipOneByte(golden: NodeGolden): { bytes: Buffer; byteOffset: number } {
	const byteOffset = 2 * (golden.text.indexOf('"length":42') + '"length":4'.length);
	const bytes = Buffer.from(golden.storedBytes, "base64");
	bytes[byteOffset] = (bytes[byteOffset] ?? 0) ^ 0x01;
	return { bytes, byteOffset };
}

export function produceCatalogNodeGoldens(): Map<string, string> {
	const components = LEAF_COMPONENTS.map(({ kind, id, text }) => {
		const bytes = storedBytes(text);
		return {
			kind,
			id,
			storedBytes: bytes.toString("base64"),
			length: bytes.length,
			digest: catalogDigest("leaf", bytes),
		};
	});
	const leafEntries: CatalogEntry[] = components.map(({ kind, id, length, digest: hex }) => ({
		kind: protocolId(kind),
		id: protocolId(id),
		length,
		digest: digest(hex),
	}));
	const withChildren = produceNode(S09A_GOLDEN_ENTRIES);
	const flipped = flipOneByte(withChildren);
	const cases = [
		{
			caseId: "leaf-node",
			kind: "node",
			contractIds: ["R4.B2", "RULING-57", "RULING-58", "RULING-68a"],
			description:
				"A node whose entries are two components (no node child); each entry's digest is the leaf digest of the component's stored bytes in input.components, a lone surrogate stored as its code unit.",
			input: { components, entries: leafEntries },
			expected: produceNode(leafEntries),
		},
		{
			caseId: "node-with-children",
			kind: "node",
			contractIds: ["R4.B2", "RULING-57", "RULING-68a"],
			description:
				"S09a's golden node: one component and one child of kind 'node' (its entry's length and digest name that child node's stored bytes).",
			input: { entries: S09A_GOLDEN_ENTRIES },
			expected: withChildren,
		},
		{
			caseId: "node-digest-mismatch",
			kind: "receiver",
			contractIds: ["R4.B2", "RULING-57", "RULING-68a"],
			description:
				"node-with-children's stored bytes with one byte flipped (the '2' of \"length\":42 becomes '3'). The text still decodes as a valid node, so only the digest catches it: the desktop verifies length and digest before decoding and fails closed, using no entry.",
			input: {
				storedBytes: flipped.bytes.toString("base64"),
				length: flipped.bytes.length,
				declaredDigest: withChildren.digest,
			},
			fault: { byteOffset: flipped.byteOffset, xor: 0x01, actualDigest: catalogDigest("node", flipped.bytes) },
			expectedOutcome: "refuse_before_decode",
		},
	];
	const files = new Map<string, string>();
	files.set("index.json", serialize(catalogNodeIndex(cases)));
	for (const fixture of cases) files.set(`${fixture.caseId}.json`, serialize(fixture));
	return files;
}

function catalogNodeIndex(cases: readonly { caseId: string; kind: string; contractIds: readonly string[] }[]) {
	return {
		contract: "CONTRACT-r6",
		section: "B2",
		rulings: ["RULING-57", "RULING-58", "RULING-68", "RULING-68a"],
		encoding:
			"expected.storedBytes is base64 of the node's exact stored bytes: the UTF-16LE code units of expected.text; expected.length is their byte count.",
		digestAlgorithm: "sha256",
		digestRule:
			"digest = lowercase hex SHA-256(u8 tagLength || tag || u64be byteLength || bytes) over the exact stored bytes, tag = ASCII 'senpi-recovery-catalog/1/utf16le/<domain>'. expected.digest uses domain 'node' (a node named by its parent's entry), expected.rootDigest domain 'root' (the node as the catalog root a manifest names); component entries use 'leaf'.",
		nodeRules: [
			'text is one JSON object {"format":"senpi-recovery-catalog","version":1,"entries":[...]} in that field order with no other field; each entry is {kind, id, length, digest} in that order, integers in canonical decimal.',
			"An entry of kind 'node' is a child catalog node; any other kind is a component leaf. length and digest name the child's exact stored bytes.",
		],
		receiverRules: [
			"Verify length and digest over the stored bytes before decoding; on a mismatch refuse the node (fail closed): decode nothing and use no entry.",
		],
		regenerate: REGENERATE,
		cases: cases.map(({ caseId, kind, contractIds }) => ({ caseId, file: `${caseId}.json`, kind, contractIds })),
	};
}
