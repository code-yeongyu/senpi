import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { catalogDigest } from "../../../src/modes/rpc/compact-catalog-codec.ts";
import { producePage } from "../../../src/modes/rpc/compact-recovery-bytes.ts";
import { materializeSource } from "../../../scripts/fragment-record-source.ts";
import type { FragmentCase } from "../../../scripts/fragment-record-fixtures.ts";
const directory = new URL("../../../docs/engine-socket/fixtures/fragment-records/", import.meta.url);
const index = JSON.parse(await readFile(new URL("index.json", directory), "utf8")) as {
	cases: { caseId: string; file: string; kind: string }[];
};
// R4.B3/T1/RULING-44/98: test the real engine fragment producer, not only the generator.
for (const row of index.cases.filter((row) => row.kind === "valid"))
	it("R4.B3: engine producer " + row.caseId, async () => {
		const fixture = JSON.parse(await readFile(new URL(row.file, directory), "utf8")) as FragmentCase;
		if (fixture.kind !== "valid") throw new Error("expected valid source");
		const bytes = Buffer.from(materializeSource(fixture.source));
		const source = {
			length: bytes.length,
			digest: catalogDigest("leaf", bytes),
			peakResidentLeaves: 0,
			range: async (offset: number, length: number) => bytes.subarray(offset, offset + length),
		};
		for (const expected of fixture.expectedRecords) {
			const page = await producePage(source, expected.offset);
			expect({
				offset: page.offset,
				...(expected.data === undefined ? {} : { data: page.bytes.toString("base64") }),
				length: page.length,
				next: page.next,
				complete: page.complete,
				digest: page.digest,
			}).toEqual(expected);
		}
	});
