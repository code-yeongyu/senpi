/**
 * Generates the shared golden fragment-record fixtures in
 * `docs/engine-socket/fixtures/fragment-records/` (CONTRACT-r6 R4.B3, senpi#4272).
 *
 * The engine (S17) and the desktop receiver (D17) both test against these files; a disagreement is
 * fixed on both sides against the fixture, never by editing a fixture to match one side. Regenerate
 * with `node packages/coding-agent/scripts/fragment-record-fixtures.ts --write`;
 * `test/suite/fragment-record-fixtures.test.ts` fails when the committed files differ byte-for-byte.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	FRAGMENT_LIMITS,
	type FragmentRecord,
	type FragmentSegment,
	type FragmentSource,
	fragmentRecords,
	materializeSource,
	sha256Hex,
} from "./fragment-record-source.ts";
import { buildFragmentFixtureIndex } from "./fragment-record-index.ts";

export const FRAGMENT_FIXTURE_DIRECTORY = "docs/engine-socket/fixtures/fragment-records";

export interface RefBinding {
	threadId: string;
	viewRevision: number;
	rowKey: string;
	field: string;
	bytes: number;
	digest: string;
}

export interface ValidFragmentCase {
	caseId: string;
	kind: "valid";
	contractIds: string[];
	description: string;
	digestAlgorithm: "sha256";
	limits: typeof FRAGMENT_LIMITS;
	source: FragmentSource;
	sourceLength: number;
	sourceDigest: string;
	expectedRecords: FragmentRecord[];
}

export interface ReceiverFragmentCase {
	caseId: string;
	kind: "receiver";
	contractIds: string[];
	description: string;
	digestAlgorithm: "sha256";
	limits: typeof FRAGMENT_LIMITS;
	source: FragmentSource;
	sourceLength: number;
	sourceDigest: string;
	binding?: RefBinding;
	change?: { viewRevision: number; source: FragmentSource; sourceLength: number; sourceDigest: string };
	fault: Record<string, string | number>;
	input: FragmentRecord[];
	expectedOutcome: "page-reset-needed";
}

export type FragmentCase = ValidFragmentCase | ReceiverFragmentCase;

const ascii = (text: string): string => Buffer.from(text, "latin1").toString("base64");
const bytesSegment = (bytes: number[] | string): FragmentSegment => ({
	kind: "bytes",
	base64: typeof bytes === "string" ? ascii(bytes) : Buffer.from(bytes).toString("base64"),
});
const repeatSegment = (pattern: number[] | string, length: number): FragmentSegment => ({
	kind: "repeat",
	patternBase64: typeof pattern === "string" ? ascii(pattern) : Buffer.from(pattern).toString("base64"),
	length,
});
const segmentsSource = (...segments: FragmentSegment[]): FragmentSource => ({
	generator: { kind: "segments", params: { segments } },
});

function validCase(caseId: string, contractIds: string[], description: string, source: FragmentSource): FragmentCase {
	const value = materializeSource(source);
	return {
		caseId,
		kind: "valid",
		contractIds,
		description,
		digestAlgorithm: "sha256",
		limits: FRAGMENT_LIMITS,
		source,
		sourceLength: value.length,
		sourceDigest: sha256Hex(value),
		expectedRecords: fragmentRecords(value, "base64" in source),
	};
}

function sourceFacts(source: FragmentSource): { source: FragmentSource; sourceLength: number; sourceDigest: string } {
	const value = materializeSource(source);
	return { source, sourceLength: value.length, sourceDigest: sha256Hex(value) };
}

const D = FRAGMENT_LIMITS.D;

function buildCases(): FragmentCase[] {
	const digestMismatchSource = segmentsSource({ kind: "xorshift32", seed: 0x5eed0009, length: D + 1 });
	const digestMismatchValue = materializeSource(digestMismatchSource);
	const digestMismatchInput = fragmentRecords(digestMismatchValue, false);
	const actualDigest = digestMismatchInput[1].digest;
	const corrupted = Uint8Array.from(digestMismatchValue.subarray(D));
	corrupted[0] ^= 0x01;
	digestMismatchInput[1] = { ...digestMismatchInput[1], digest: sha256Hex(corrupted) };

	const staleMinted = { base64: ascii("stale ref value v1") };
	const staleChanged = { base64: ascii("stale ref value v2") };
	const staleMintedFacts = sourceFacts(staleMinted);

	const outOfOrderSource = segmentsSource({ kind: "xorshift32", seed: 0x5eed0011, length: 2 * D + 1 });
	const outOfOrderRecords = fragmentRecords(materializeSource(outOfOrderSource), false);

	return [
		validCase(
			"empty-field",
			["R4.B3"],
			"Zero raw bytes: exactly one record of length 0, complete, next null.",
			{ base64: "" },
		),
		validCase("single-small", ["R4.B3"], "17 ASCII bytes in one complete record.", {
			base64: ascii("single small 17B!"),
		}),
		validCase(
			"exact-D",
			["R4.B3"],
			"Exactly D raw bytes: one complete record, no empty trailing record.",
			segmentsSource(repeatSegment("exact-D ", D)),
		),
		validCase(
			"D-plus-1",
			["R4.B3"],
			"D + 1 raw bytes: two records of D and 1 bytes.",
			segmentsSource(repeatSegment("0123456789", D + 1)),
		),
		validCase(
			"multi-fragment-over-S",
			["R4.B3"],
			"1,310,720 raw bytes (over S = 1,048,576): ten D-byte records, contiguous offsets, last complete.",
			segmentsSource({ kind: "xorshift32", seed: 0x5eed0005, length: 10 * D }),
		),
		validCase(
			"utf8-split",
			["R4.B3"],
			"U+1F600 (F0 9F 98 80) starts at offset 131070: record 1 ends with F0 9F, record 2 starts with 98 80; reassembly is byte-exact.",
			segmentsSource(repeatSegment("a", D - 2), bytesSegment([0xf0, 0x9f, 0x98, 0x80]), bytesSegment("tail")),
		),
		validCase(
			"nul-bytes",
			["R4.B3"],
			"0x00 runs at offsets 4-7, 131068-131075 (straddling the D boundary) and at the end.",
			segmentsSource(
				bytesSegment("head"),
				repeatSegment([0], 4),
				repeatSegment("n", D - 12),
				repeatSegment([0], 8),
				bytesSegment("tail"),
				repeatSegment([0], 2),
			),
		),
		validCase(
			"json-escape-split",
			["R4.B3"],
			'Raw bytes of a JSON string literal whose \\u00e9 escape starts at offset 131071: record 1 ends with the lone backslash, record 2 starts with "u00e9". Bytes are not parsed.',
			segmentsSource(bytesSegment('"'), repeatSegment("j", D - 2), bytesSegment('\\u00e9 tail"')),
		),
		{
			caseId: "digest-mismatch",
			kind: "receiver",
			contractIds: ["R4.B3", "R4.B5", "RULING-37", "RULING-44"],
			description:
				"Record 2 declares a digest that does not match its bytes. The receiver must answer page-reset-needed and must not complete or deliver the value.",
			digestAlgorithm: "sha256",
			limits: FRAGMENT_LIMITS,
			...sourceFacts(digestMismatchSource),
			fault: {
				recordIndex: 1,
				field: "digest",
				declaredDigest: digestMismatchInput[1].digest,
				actualDigest,
				corruption: "declaredDigest is sha256 of the record bytes with the first byte XOR 0x01",
			},
			input: digestMismatchInput,
			expectedOutcome: "page-reset-needed",
		},
		{
			caseId: "stale-ref",
			kind: "receiver",
			contractIds: ["R4.B3", "R4.C2", "RULING-37", "RULING-44"],
			description:
				"A ref minted at viewRevision 41 is fetched after the row changed at viewRevision 42 to a value of the same length. The engine answers page-reset-needed; a receiver given the changed bytes must reject them against the binding digest. Never other bytes.",
			digestAlgorithm: "sha256",
			limits: FRAGMENT_LIMITS,
			...staleMintedFacts,
			binding: {
				threadId: "thread-sf1-fixture",
				viewRevision: 41,
				rowKey: "row-sf1-fixture",
				field: "content",
				bytes: staleMintedFacts.sourceLength,
				digest: staleMintedFacts.sourceDigest,
			},
			change: { viewRevision: 42, ...sourceFacts(staleChanged) },
			fault: {
				field: "digest",
				reason: "concatenated input bytes match the changed row (viewRevision 42), not binding.digest",
			},
			input: fragmentRecords(materializeSource(staleChanged), true),
			expectedOutcome: "page-reset-needed",
		},
		{
			caseId: "out-of-order-offset",
			kind: "receiver",
			contractIds: ["R4.B3", "R4.B5", "RULING-37", "RULING-44"],
			description:
				"The second delivered record is the third fragment (offset 262144) although the previous record ends at 131072. The receiver must answer page-reset-needed and must not complete or deliver the value.",
			digestAlgorithm: "sha256",
			limits: FRAGMENT_LIMITS,
			...sourceFacts(outOfOrderSource),
			fault: { recordIndex: 1, field: "offset", expectedOffset: D, declaredOffset: 2 * D },
			input: [outOfOrderRecords[0], outOfOrderRecords[2]],
			expectedOutcome: "page-reset-needed",
		},
	];
}

const serialize = (value: unknown): string => `${JSON.stringify(value, null, "\t")}\n`;

export function buildFragmentRecordFixtures(): Map<string, string> {
	const cases = buildCases();
	const files = new Map<string, string>();
	files.set("index.json", serialize(buildFragmentFixtureIndex(cases)));
	for (const fixture of cases) files.set(`${fixture.caseId}.json`, serialize(fixture));
	return files;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--write")) {
	const directory = join(dirname(fileURLToPath(import.meta.url)), "..", FRAGMENT_FIXTURE_DIRECTORY);
	mkdirSync(directory, { recursive: true });
	for (const [name, content] of buildFragmentRecordFixtures()) writeFileSync(join(directory, name), content);
}
