// senpi#4726 (R12.a): case IDs unique, mapping complete, suite hash computed.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildManifest, findMappingProblems, type MappingProblemCode } from "../../src/conformance/mapping.ts";
import { CONFORMANCE_REGISTRY, type RegisteredCase } from "../../src/conformance/registry.ts";
import { computeSuiteHash, sha256Hex } from "../../src/conformance/suite-hash.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const readRepoFile = async (path: string): Promise<Uint8Array> => readFile(`${REPO_ROOT}${path}`);
const nodeSha256 = (text: string | Uint8Array): string => createHash("sha256").update(text).digest("hex");

const sampleCase = (overrides: Partial<RegisteredCase> = {}): RegisteredCase => ({
	id: "STORE-01",
	impl: "packages/agent/src/conformance/registry.ts",
	intro: "#1",
	adapters: ["store"],
	expected: "a cut at every write point leaves the last committed batch",
	...overrides,
});

describe("the conformance registry", () => {
	it("has unique case IDs and a complete mapping for every case", () => {
		expect(findMappingProblems(CONFORMANCE_REGISTRY)).toEqual([]);
	});

	it("exports a manifest that hashes every implementation file and carries the suite hash", async () => {
		const manifest = await buildManifest(CONFORMANCE_REGISTRY, readRepoFile);

		expect(manifest.cases.map((entry) => entry.id)).toEqual(CONFORMANCE_REGISTRY.map((entry) => entry.id));
		for (const entry of manifest.cases) {
			expect(entry.impl_hash).toBe(nodeSha256(await readRepoFile(entry.impl)));
		}
		expect(manifest.suite_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(manifest.suite_hash).toBe(await computeSuiteHash(manifest.cases));
	});
});

describe("findMappingProblems", () => {
	const rows: ReadonlyArray<{
		name: string;
		cases: RegisteredCase[];
		problems: Array<{ id: string; code: MappingProblemCode }>;
	}> = [
		{
			name: "a duplicate ID",
			cases: [sampleCase(), sampleCase({ expected: "another outcome" })],
			problems: [{ id: "STORE-01", code: "duplicate-id" }],
		},
		{ name: "an empty ID", cases: [sampleCase({ id: "" })], problems: [{ id: "", code: "malformed-id" }] },
		{
			name: "a lowercase ID",
			cases: [sampleCase({ id: "store-01" })],
			problems: [{ id: "store-01", code: "malformed-id" }],
		},
		{
			name: "a trailing dash",
			cases: [sampleCase({ id: "STORE-" })],
			problems: [{ id: "STORE-", code: "malformed-id" }],
		},
		{
			name: "an absolute impl",
			cases: [sampleCase({ impl: "/abs/cases.ts" })],
			problems: [{ id: "STORE-01", code: "malformed-impl" }],
		},
		{
			name: "a parent-relative impl",
			cases: [sampleCase({ impl: "packages/../cases.ts" })],
			problems: [{ id: "STORE-01", code: "malformed-impl" }],
		},
		{
			name: "a backslash impl",
			cases: [sampleCase({ impl: "packages\\agent\\cases.ts" })],
			problems: [{ id: "STORE-01", code: "malformed-impl" }],
		},
		{
			name: "a non-TypeScript impl",
			cases: [sampleCase({ impl: "packages/agent/cases.js" })],
			problems: [{ id: "STORE-01", code: "malformed-impl" }],
		},
		{
			name: "an empty intro",
			cases: [sampleCase({ intro: " " })],
			problems: [{ id: "STORE-01", code: "missing-intro" }],
		},
		{
			name: "no adapters",
			cases: [sampleCase({ adapters: [] })],
			problems: [{ id: "STORE-01", code: "missing-adapters" }],
		},
		{
			name: "a repeated adapter",
			cases: [sampleCase({ adapters: ["store", "wake", "store"] })],
			problems: [{ id: "STORE-01", code: "duplicate-adapter" }],
		},
		{
			name: "an empty expected outcome",
			cases: [sampleCase({ expected: "" })],
			problems: [{ id: "STORE-01", code: "missing-expected" }],
		},
	];

	for (const row of rows) {
		it(`reports ${row.name}`, () => {
			expect(findMappingProblems(row.cases)).toEqual(row.problems);
		});
	}

	it("accepts well-formed cases, including multi-part IDs and several adapters", () => {
		const cases = [
			sampleCase(),
			sampleCase({ id: "KILL-STORE-01" }),
			sampleCase({ id: "FAULT-HAND-MULTI-01", adapters: ["executor", "transport"] }),
		];
		expect(findMappingProblems(cases)).toEqual([]);
	});
});

describe("buildManifest", () => {
	it("refuses a registry with mapping problems", async () => {
		await expect(buildManifest([sampleCase(), sampleCase()], readRepoFile)).rejects.toThrow(/STORE-01.*duplicate-id/);
	});

	it("refuses a case whose implementation file cannot be read", async () => {
		const missing = sampleCase({ impl: "packages/agent/src/conformance/does-not-exist.ts" });
		await expect(buildManifest([missing], readRepoFile)).rejects.toThrow(/STORE-01.*does-not-exist\.ts/);
	});
});

describe("the suite hash", () => {
	const wake = { id: "WAKE-01", impl_hash: "b".repeat(64) };
	const store = { id: "STORE-01", impl_hash: "a".repeat(64) };
	const entries = [wake, store];

	it("hashes bytes with SHA-256", async () => {
		expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(nodeSha256("abc"));
	});

	it("is SHA-256 over the ID-sorted `id<TAB>impl_hash` lines", async () => {
		const canonical = `STORE-01\t${"a".repeat(64)}\nWAKE-01\t${"b".repeat(64)}\n`;
		expect(await computeSuiteHash(entries)).toBe(nodeSha256(canonical));
	});

	it("does not depend on registration order", async () => {
		expect(await computeSuiteHash([...entries].reverse())).toBe(await computeSuiteHash(entries));
	});

	it("changes when a case is added, removed or renamed, or an implementation changes", async () => {
		const base = await computeSuiteHash(entries);
		const variants = [
			[...entries, { id: "WAKE-02", impl_hash: "c".repeat(64) }],
			[wake],
			[wake, { id: "STORE-02", impl_hash: store.impl_hash }],
			[wake, { id: "STORE-01", impl_hash: "d".repeat(64) }],
		];
		for (const variant of variants) {
			expect(await computeSuiteHash(variant)).not.toBe(base);
		}
	});

	it("refuses duplicate case IDs", async () => {
		await expect(computeSuiteHash([store, { id: "STORE-01", impl_hash: "e".repeat(64) }])).rejects.toThrow(
			/STORE-01/,
		);
	});
});
