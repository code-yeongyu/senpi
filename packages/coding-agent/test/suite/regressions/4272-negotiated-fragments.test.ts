import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { catalogDigest } from "../../../src/modes/rpc/compact-catalog-codec.ts";
import { producePage, type RecoveryPage } from "../../../src/modes/rpc/compact-recovery-bytes.ts";
import { FRAGMENT_LIMITS, type FragmentRecord, materializeSource } from "../../../scripts/fragment-record-source.ts";
import type { FragmentCase } from "../../../scripts/fragment-record-fixtures.ts";
const directory = new URL("../../../docs/engine-socket/fixtures/fragment-records/", import.meta.url);
const index = JSON.parse(await readFile(new URL("index.json", directory), "utf8")) as {
	cases: { caseId: string; file: string; kind: string }[];
};
it("RULING-100: desktop's shared receiver loop contains exactly the three adverse cases", async () => {
	const receivers = index.cases.filter((row) => row.kind === "receiver");
	expect(receivers.map((row) => row.file).sort()).toEqual([
		"digest-mismatch.json",
		"out-of-order-offset.json",
		"stale-ref.json",
	]);
	for (const row of receivers) {
		const fixture = JSON.parse(await readFile(new URL(row.file, directory), "utf8")) as FragmentCase;
		expect(fixture).toMatchObject({ kind: "receiver", caseId: row.caseId, expectedOutcome: "page-reset-needed" });
	}
});

// R4.B3/T1/RULING-44/98/100: the real producer must emit valid records, never a receiver's adverse input.
for (const row of index.cases)
	it("R4.B3: engine producer " + row.caseId, async () => {
		const fixture = JSON.parse(await readFile(new URL(row.file, directory), "utf8")) as FragmentCase;
		const bytes = Buffer.from(materializeSource(fixture.source));
		const source = {
			length: bytes.length,
			digest: catalogDigest("leaf", bytes),
			peakResidentLeaves: 0,
			range: async (offset: number, length: number) => bytes.subarray(offset, offset + length),
		};
		const records: FragmentRecord[] = [];
		const parts: Buffer[] = [];
		for (let offset: number | null = 0; offset !== null;) {
			const page: RecoveryPage = await producePage(source, offset);
			const length = Math.min(FRAGMENT_LIMITS.D, bytes.length - offset);
			const end = offset + length;
			const slice = bytes.subarray(offset, end);
			expect(page).toEqual({
				offset,
				length,
				bytes: slice,
				digest: catalogDigest("fragment", slice),
				next: end < bytes.length ? end : null,
				complete: end === bytes.length,
			});
			expect(page.bytes.toString("base64").length + FRAGMENT_LIMITS.H).toBeLessThanOrEqual(FRAGMENT_LIMITS.F);
			records.push({
				offset: page.offset,
				...("base64" in fixture.source ? { data: page.bytes.toString("base64") } : {}),
				length: page.length,
				next: page.next,
				complete: page.complete,
				digest: page.digest,
			});
			parts.push(page.bytes);
			offset = page.next;
		}
		const produced = Buffer.concat(parts);
		expect(produced).toEqual(bytes);
		expect(produced.length).toBe(fixture.sourceLength);
		expect(catalogDigest("leaf", produced)).toBe(fixture.sourceDigest);
		if (fixture.kind === "valid") expect(records).toEqual(fixture.expectedRecords);
		else {
			expect(records).not.toEqual(fixture.input);
			if (fixture.binding) {
				// The frozen ref serves its bound source, not the changed row in the adverse input.
				expect(produced.length).toBe(fixture.binding.bytes);
				expect(catalogDigest("leaf", produced)).toBe(fixture.binding.digest);
				expect(catalogDigest("leaf", produced)).not.toBe(fixture.change?.sourceDigest);
			}
		}
	});
