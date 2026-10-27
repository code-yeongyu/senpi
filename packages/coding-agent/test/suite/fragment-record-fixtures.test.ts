import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildFragmentRecordFixtures,
	FRAGMENT_FIXTURE_DIRECTORY,
	type FragmentCase,
	type ReceiverFragmentCase,
	type ValidFragmentCase,
} from "../../scripts/fragment-record-fixtures.ts";
import { FRAGMENT_LIMITS, type FragmentRecord, materializeSource } from "../../scripts/fragment-record-source.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureDirectory = join(packageRoot, FRAGMENT_FIXTURE_DIRECTORY);
const CASE_IDS = [
	"empty-field",
	"single-small",
	"exact-D",
	"D-plus-1",
	"multi-fragment-over-S",
	"utf8-split",
	"nul-bytes",
	"json-escape-split",
	"digest-mismatch",
	"stale-ref",
	"out-of-order-offset",
];

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const readCase = (caseId: string): FragmentCase =>
	JSON.parse(readFileSync(join(fixtureDirectory, `${caseId}.json`), "utf8"));
function readValid(caseId: string): ValidFragmentCase {
	const fixture = readCase(caseId);
	if (fixture.kind !== "valid") throw new Error(`${caseId} is not a valid case`);
	return fixture;
}
function readReceiver(caseId: string): ReceiverFragmentCase {
	const fixture = readCase(caseId);
	if (fixture.kind !== "receiver") throw new Error(`${caseId} is not a receiver case`);
	return fixture;
}
const recordBytes = (record: FragmentRecord, source: Uint8Array): Uint8Array =>
	record.data === undefined
		? source.subarray(record.offset, record.offset + record.length)
		: Buffer.from(record.data, "base64");

function expectRecordSequence(records: FragmentRecord[], source: Uint8Array): void {
	let offset = 0;
	const parts: Uint8Array[] = [];
	for (const [index, record] of records.entries()) {
		const last = index === records.length - 1;
		const bytes = recordBytes(record, source);
		expect(record.offset).toBe(offset);
		expect(bytes.length).toBe(record.length);
		expect(record.length).toBeLessThanOrEqual(FRAGMENT_LIMITS.D);
		expect(Buffer.from(bytes).toString("base64").length + FRAGMENT_LIMITS.H).toBeLessThanOrEqual(FRAGMENT_LIMITS.F);
		expect(record.digest).toBe(sha256(bytes));
		expect(record.complete).toBe(last);
		expect(record.next).toBe(last ? null : record.offset + record.length);
		if (!last) expect(record.length).toBe(FRAGMENT_LIMITS.D);
		parts.push(bytes);
		offset += record.length;
	}
	expect(Buffer.compare(Buffer.concat(parts), Buffer.from(source))).toBe(0);
}

describe("shared golden fragment-record fixtures (CONTRACT-r6 B3, senpi#4272)", () => {
	it("committed files are byte-identical to the generator output and nothing else is in the directory", () => {
		const generated = buildFragmentRecordFixtures();
		expect(readdirSync(fixtureDirectory).sort()).toEqual([...generated.keys()].sort());
		for (const [name, content] of generated) {
			expect(readFileSync(join(fixtureDirectory, name), "utf8"), name).toBe(content);
		}
	});

	it("index.json lists the eleven cases in order with their kinds and the pending digest ruling", () => {
		const index = JSON.parse(readFileSync(join(fixtureDirectory, "index.json"), "utf8"));
		expect(index).toMatchObject({
			contract: "CONTRACT-r6",
			section: "B3",
			digestAlgorithm: "sha256",
			digestRulingPending: "S09-Q1",
			limits: { D: 131_072, F: 262_144, H: 16_384 },
		});
		expect(index.cases).toEqual(
			CASE_IDS.map((caseId, position) => ({
				caseId,
				file: `${caseId}.json`,
				kind: position < 8 ? "valid" : "receiver",
			})),
		);
	});

	it.each(CASE_IDS.slice(0, 8))("%s: records reassemble the source byte-exactly within D/F/H", (caseId) => {
		const fixture = readValid(caseId);
		expect(fixture).toMatchObject({ caseId, kind: "valid", digestAlgorithm: "sha256", limits: FRAGMENT_LIMITS });
		const source = materializeSource(fixture.source);
		expect(source.length).toBe(fixture.sourceLength);
		expect(sha256(source)).toBe(fixture.sourceDigest);
		expect(
			fixture.expectedRecords.every((record) => (record.data === undefined) === "generator" in fixture.source),
		).toBe(true);
		expectRecordSequence(fixture.expectedRecords, source);
	});

	it("pins the case-list sizes and record counts", () => {
		const shape = CASE_IDS.slice(0, 8).map((caseId) => {
			const fixture = readValid(caseId);
			return [caseId, fixture.sourceLength, fixture.expectedRecords.map((record) => record.length)];
		});
		const D = FRAGMENT_LIMITS.D;
		expect(shape).toEqual([
			["empty-field", 0, [0]],
			["single-small", 17, [17]],
			["exact-D", D, [D]],
			["D-plus-1", D + 1, [D, 1]],
			["multi-fragment-over-S", 1_310_720, Array.from({ length: 10 }, () => D)],
			["utf8-split", D + 6, [D, 6]],
			["nul-bytes", D + 10, [D, 10]],
			["json-escape-split", D + 11, [D, 11]],
		]);
	});

	it("utf8-split: U+1F600 starts at offset 131070 and straddles the D boundary", () => {
		const fixture = readValid("utf8-split");
		const source = materializeSource(fixture.source);
		const emoji = Buffer.from("\u{1F600}", "utf8");
		expect(Buffer.from(source.subarray(131_070, 131_074)).equals(emoji)).toBe(true);
		const [first, second] = fixture.expectedRecords.map((record) => recordBytes(record, source));
		expect([...first.subarray(-2)]).toEqual([0xf0, 0x9f]);
		expect([...second.subarray(0, 2)]).toEqual([0x98, 0x80]);
		expect(Buffer.from(source).toString("utf8")).toContain("\u{1F600}");
	});

	it("nul-bytes and json-escape-split put their boundary bytes across offset D", () => {
		const D = FRAGMENT_LIMITS.D;
		const nul = materializeSource(readValid("nul-bytes").source);
		expect([...nul.subarray(D - 4, D + 4)]).toEqual(Array.from({ length: 8 }, () => 0));
		const escape = materializeSource(readValid("json-escape-split").source);
		expect(Buffer.from(escape.subarray(D - 1, D + 5)).toString("latin1")).toBe("\\u00e9");
	});

	it("digest-mismatch: only record 2's declared digest disagrees with its bytes", () => {
		const fixture = readReceiver("digest-mismatch");
		const source = materializeSource(fixture.source);
		expect(fixture.expectedOutcome).toBe("page-reset-needed");
		const [first, second] = fixture.input;
		expect(first.digest).toBe(sha256(recordBytes(first, source)));
		expect(second.digest).not.toBe(sha256(recordBytes(second, source)));
		expect(fixture.fault).toMatchObject({ recordIndex: 1, declaredDigest: second.digest });
		expectRecordSequence([first, { ...second, digest: sha256(recordBytes(second, source)) }], source);
	});

	it("stale-ref: delivered bytes are the changed row, not the bytes the ref bound at minting", () => {
		const fixture = readReceiver("stale-ref");
		expect(fixture.expectedOutcome).toBe("page-reset-needed");
		const minted = materializeSource(fixture.source);
		expect(fixture.binding).toEqual({
			threadId: "thread-sf1-fixture",
			viewRevision: 41,
			rowKey: "row-sf1-fixture",
			field: "content",
			bytes: minted.length,
			digest: sha256(minted),
		});
		const changed = materializeSource(fixture.change?.source ?? { base64: "" });
		expect(fixture.change?.viewRevision).toBe(42);
		expect(changed.length).toBe(minted.length);
		expectRecordSequence(fixture.input, changed);
		expect(sha256(changed)).not.toBe(fixture.binding?.digest);
	});

	it("out-of-order-offset: record 2's offset skips past the previous record's end", () => {
		const fixture = readReceiver("out-of-order-offset");
		const source = materializeSource(fixture.source);
		expect(fixture.expectedOutcome).toBe("page-reset-needed");
		const [first, second] = fixture.input;
		expect(second.offset).not.toBe(first.offset + first.length);
		expect(fixture.fault).toMatchObject({
			expectedOffset: first.offset + first.length,
			declaredOffset: second.offset,
		});
		for (const record of fixture.input) expect(record.digest).toBe(sha256(recordBytes(record, source)));
	});

	it("the package files list ships the fixtures", () => {
		const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
		expect(manifest.files).toContain("docs/engine-socket/fixtures/**");
	});
});
