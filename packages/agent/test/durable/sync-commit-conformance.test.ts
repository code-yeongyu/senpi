// senpi#5827 (S20a): the SYNC-COMMIT cases on the memory backend, through the suite runner.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildManifest, findImplementationGaps } from "../../src/conformance/mapping.ts";
import { type HostReport, runSuite } from "../../src/conformance/runner.ts";
import { createMemoryStoreMedium, type MemoryStoreMedium, openMemoryStore } from "../../src/durable/store-memory.ts";
import {
	SYNC_COMMIT_CASES,
	SYNC_COMMIT_REGISTRY,
	type SyncCommitConformanceAdapter,
} from "../../src/durable/testing/sync-commit-cases.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function memoryAdapter(): SyncCommitConformanceAdapter {
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
			return openMemoryStore(medium, options);
		},
	};
}

describe("the memory backend on the SYNC-COMMIT cases", () => {
	let report: HostReport;
	beforeAll(async () => {
		const manifest = await buildManifest(SYNC_COMMIT_REGISTRY, (path) => readFile(`${REPO_ROOT}${path}`));
		report = await runSuite(
			manifest,
			{ name: "memory", provides: ["store"], adapters: { store: memoryAdapter() } },
			SYNC_COMMIT_CASES,
		);
	});

	it("implements every registered SYNC-COMMIT case", () => {
		expect(findImplementationGaps(SYNC_COMMIT_REGISTRY, SYNC_COMMIT_CASES)).toEqual({
			unimplemented: [],
			unregistered: [],
		});
	});

	for (const entry of SYNC_COMMIT_REGISTRY) {
		it(`passes ${entry.id}`, () => {
			expect(report.results.find((result) => result.id === entry.id)).toEqual({ id: entry.id, status: "pass" });
		});
	}
});
