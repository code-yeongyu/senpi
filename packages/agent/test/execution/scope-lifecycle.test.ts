// senpi#5681 (S15): scope lifecycle, LIFECYCLE-01..03, SCOPE-01..02 and MULTI-LIFE-01 on the memory store.
import { describe, expect, it } from "vitest";
import { findImplementationGaps } from "../../src/conformance/mapping.ts";
import { CONFORMANCE_REGISTRY } from "../../src/conformance/registry.ts";
import { createMemoryStoreMedium, type MemoryStoreMedium, openMemoryStore } from "../../src/durable/store-memory.ts";
import type { StoreConformanceAdapter } from "../../src/durable/testing/store-harness.ts";
import { referenceBatchExecutor } from "../../src/execution/testing/batch-executor.ts";
import { LIFECYCLE_CASES } from "../../src/execution/testing/lifecycle-cases.ts";
import { MULTI_LIFECYCLE_CASES } from "../../src/execution/testing/multi-lifecycle-cases.ts";
import { SCOPE_CASES } from "../../src/execution/testing/scope-cases.ts";

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

const cases = new Map([...LIFECYCLE_CASES, ...SCOPE_CASES, ...MULTI_LIFECYCLE_CASES]);

describe("scope lifecycle conformance on the memory store", () => {
	for (const [id, run] of cases) it(id, () => run({ store: memoryStore(), executor: referenceBatchExecutor }));

	it("registers every LIFECYCLE, SCOPE and MULTI-LIFE case with an implementation", () => {
		const registry = CONFORMANCE_REGISTRY.filter(({ id }) => /^(LIFECYCLE|SCOPE|MULTI-LIFE)-/.test(id));
		expect(registry).toHaveLength(6);
		expect(findImplementationGaps(registry, cases)).toEqual({ unimplemented: [], unregistered: [] });
	});
});
