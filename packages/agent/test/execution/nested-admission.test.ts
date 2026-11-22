// senpi#5669 (S13): nested admission on the brain, NEST-01..09, CANCEL-01..02 and KILL-NEST-01..03 on the memory store.
import { describe, expect, it } from "vitest";
import { findImplementationGaps } from "../../src/conformance/mapping.ts";
import { CONFORMANCE_REGISTRY } from "../../src/conformance/registry.ts";
import { createMemoryStoreMedium, type MemoryStoreMedium, openMemoryStore } from "../../src/durable/store-memory.ts";
import type { StoreConformanceAdapter } from "../../src/durable/testing/store-harness.ts";
import { referenceBatchExecutor } from "../../src/execution/testing/batch-executor.ts";
import { CANCEL_CASES } from "../../src/execution/testing/cancel-cases.ts";
import { KILL_NEST_CASES } from "../../src/execution/testing/kill-nest.ts";
import { NEST_CASES } from "../../src/execution/testing/nest-cases.ts";

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

const cases = new Map([...NEST_CASES, ...CANCEL_CASES, ...KILL_NEST_CASES]);

describe("nested admission conformance on the memory store", () => {
	for (const [id, run] of cases) it(id, () => run({ store: memoryStore(), executor: referenceBatchExecutor }));

	it("registers every NEST, CANCEL and KILL-NEST case with an implementation", () => {
		const registry = CONFORMANCE_REGISTRY.filter(({ id }) => /^(NEST|CANCEL|KILL-NEST)-/.test(id));
		expect(registry).toHaveLength(14);
		expect(findImplementationGaps(registry, cases)).toEqual({ unimplemented: [], unregistered: [] });
	});
});
