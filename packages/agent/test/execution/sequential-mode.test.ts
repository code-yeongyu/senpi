// senpi#5661 (S11): the coordinator's sequential mode (SEQ-01) and MULTI-FAIR-02 on the memory store.
import { describe, expect, it } from "vitest";
import { findImplementationGaps } from "../../src/conformance/mapping.ts";
import { CONFORMANCE_REGISTRY } from "../../src/conformance/registry.ts";
import { createMemoryStoreMedium, type MemoryStoreMedium, openMemoryStore } from "../../src/durable/store-memory.ts";
import type { StoreConformanceAdapter } from "../../src/durable/testing/store-harness.ts";
import { referenceBatchExecutor } from "../../src/execution/testing/batch-executor.ts";
import { MULTI_SEQ_CASES } from "../../src/execution/testing/multi-seq-cases.ts";
import { SEQ_CASES } from "../../src/execution/testing/seq-cases.ts";

function memoryStore(): StoreConformanceAdapter {
	const media = new Map<string, MemoryStoreMedium>();
	return {
		createMedium: async () => {
			const id = `medium-${media.size}`;
			media.set(id, createMemoryStoreMedium());
			return id;
		},
		open: async (id, options) => {
			const medium = media.get(id);
			if (medium === undefined) throw new Error(`unknown medium ${id}`);
			return openMemoryStore(medium, options);
		},
	};
}

const cases = new Map([...SEQ_CASES, ...MULTI_SEQ_CASES]);

describe("sequential coordinator conformance on the memory store", () => {
	for (const [id, run] of cases) {
		it(id, async () => {
			await run({ store: memoryStore(), executor: referenceBatchExecutor });
		});
	}

	it("has a runnable implementation for every registered SEQ and MULTI-FAIR-02 case", () => {
		const registry = CONFORMANCE_REGISTRY.filter(({ id }) => /^SEQ-|^MULTI-FAIR-02$/.test(id));
		expect(registry.map(({ id }) => id)).toEqual(["SEQ-01", "MULTI-FAIR-02"]);
		expect(findImplementationGaps(registry, cases)).toEqual({ unimplemented: [], unregistered: [] });
	});
});
