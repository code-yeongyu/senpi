// senpi#4729 (R1.a): the STORE and KILL-STORE conformance cases on the memory backend, through the suite runner.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildManifest, findImplementationGaps } from "../../src/conformance/mapping.ts";
import { CONFORMANCE_REGISTRY } from "../../src/conformance/registry.ts";
import { type CaseImplementation, type HostReport, runSuite } from "../../src/conformance/runner.ts";
import type { DurableStore } from "../../src/durable/store.ts";
import { createMemoryStoreMedium, type MemoryStoreMedium, openMemoryStore } from "../../src/durable/store-memory.ts";
import { KILL_STORE_CASES, KILL_STORE_DECLARATIONS } from "../../src/durable/testing/kill-store.ts";
import { STORE_CASES } from "../../src/durable/testing/store-cases.ts";
import type { StoreCaseAdapters, StoreConformanceAdapter } from "../../src/durable/testing/store-harness.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const readRepoFile = async (path: string): Promise<Uint8Array> => readFile(`${REPO_ROOT}${path}`);

const IMPLEMENTATIONS = new Map<string, CaseImplementation<StoreCaseAdapters>>([...STORE_CASES, ...KILL_STORE_CASES]);
const STORE_REGISTRY = CONFORMANCE_REGISTRY.filter((entry) => /^(KILL-)?STORE-/.test(entry.id));
const STORE_IDS = ["01", "02", "03", "04", "05", "06", "07"].map((n) => `STORE-${n}`);
const KILL_IDS = ["01", "02", "03", "04", "05", "06"].map((n) => `KILL-STORE-${n}`);

function memoryAdapter(wrap: (store: DurableStore) => DurableStore = (store) => store): StoreConformanceAdapter {
	const media = new Map<string, MemoryStoreMedium>();
	return {
		createMedium: async () => {
			const name = `medium-${media.size + 1}`;
			media.set(name, createMemoryStoreMedium());
			return name;
		},
		open: async (name, options) => {
			const medium = media.get(name);
			if (medium === undefined) throw new Error(`no memory medium named ${name}`);
			return wrap(openMemoryStore(medium, options));
		},
	};
}

async function runOnMemory(wrap?: (store: DurableStore) => DurableStore): Promise<HostReport> {
	const manifest = await buildManifest(STORE_REGISTRY, readRepoFile);
	return runSuite(
		manifest,
		{ name: "memory", provides: ["store"], adapters: { store: memoryAdapter(wrap) } },
		IMPLEMENTATIONS,
	);
}

describe("the STORE and KILL-STORE registration", () => {
	it("registers STORE-01..07 and KILL-STORE-01..06 with their implementation files, all needing only a store", () => {
		expect(STORE_REGISTRY.map((entry) => [entry.id, entry.impl, entry.adapters])).toEqual([
			...STORE_IDS.map((id) => [id, "packages/agent/src/durable/testing/store-cases.ts", ["store"]]),
			...KILL_IDS.map((id) => [id, "packages/agent/src/durable/testing/kill-store.ts", ["store"]]),
		]);
	});

	it("has an implementation for every registered case and a registered case for every implementation", () => {
		expect(findImplementationGaps(STORE_REGISTRY, IMPLEMENTATIONS)).toEqual({ unimplemented: [], unregistered: [] });
	});

	it("declares a placement for a kill before and after every durable store write", () => {
		const points = KILL_STORE_DECLARATIONS.map(({ id, op, at, placement }) => `${id} ${op}/${at} ${placement}`);
		expect(points).toEqual([
			"KILL-STORE-01 commit/before everywhere",
			"KILL-STORE-02 commit/durable everywhere",
			"KILL-STORE-03 claim/before everywhere",
			"KILL-STORE-04 claim/durable everywhere",
			"KILL-STORE-05 import/before everywhere",
			"KILL-STORE-06 import/durable everywhere",
		]);
	});
});

describe("the memory backend", () => {
	let report: HostReport;
	beforeAll(async () => {
		report = await runOnMemory();
	});

	for (const id of [...STORE_IDS, ...KILL_IDS]) {
		it(`passes ${id}`, () => {
			expect(report.results.find((result) => result.id === id)).toEqual({ id, status: "pass" });
		});
	}
});

describe("the cases fail a store that breaks the contract", () => {
	const rows: ReadonlyArray<{ name: string; wrap: (store: DurableStore) => DurableStore; failing: string[] }> = [
		{
			name: "commits under whatever epoch is current (no fence)",
			wrap: (store) => ({
				...bound(store),
				commit: async (_epoch, writes, adopt) => store.commit(await store.readEpoch(), writes, adopt),
			}),
			failing: ["STORE-04", "KILL-STORE-04"],
		},
		{
			name: "adopts every batch twice",
			wrap: (store) => ({
				...bound(store),
				commit: (epoch, writes, adopt) =>
					store.commit(epoch, writes, (result) => {
						adopt(result);
						adopt(result);
					}),
			}),
			failing: ["STORE-01", "STORE-02", "STORE-03", "KILL-STORE-01"],
		},
	];

	for (const row of rows) {
		it(`fails exactly the cases that observe a store that ${row.name}`, async () => {
			const failed = (await runOnMemory(row.wrap)).results.filter((r) => r.status === "fail").map((r) => r.id);
			expect(failed).toEqual(row.failing);
		});
	}
});

function bound(store: DurableStore): DurableStore {
	return {
		readEpoch: () => store.readEpoch(),
		readHead: () => store.readHead(),
		claim: (expected, next) => store.claim(expected, next),
		commit: (epoch, writes, adopt) => store.commit(epoch, writes, adopt),
		mintId: () => store.mintId(),
		scanRecords: (query) => store.scanRecords(query),
		getDocument: (key) => store.getDocument(key),
		scanDocuments: (prefix) => store.scanDocuments(prefix),
		exportSnapshot: () => store.exportSnapshot(),
		importSnapshot: (epoch, snapshot) => store.importSnapshot(epoch, snapshot),
	};
}
