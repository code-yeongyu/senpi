// senpi#5675 (S14): the durable wake path (WAKEX and KILL-WAKEX) on the memory store.
import { describe, expect, it } from "vitest";
import { findImplementationGaps } from "../../src/conformance/mapping.ts";
import { CONFORMANCE_REGISTRY } from "../../src/conformance/registry.ts";
import { createMemoryStoreMedium, type MemoryStoreMedium, openMemoryStore } from "../../src/durable/store-memory.ts";
import type { StoreConformanceAdapter } from "../../src/durable/testing/store-harness.ts";
import { referenceBatchExecutor } from "../../src/execution/testing/batch-executor.ts";
import { KILL_WAKEX_CASES } from "../../src/execution/testing/kill-wakex.ts";
import { WAKE_EXEC_CASES } from "../../src/execution/testing/wake-exec-cases.ts";

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

const cases = new Map([...WAKE_EXEC_CASES, ...KILL_WAKEX_CASES]);

describe("durable wake conformance on the memory store", () => {
	for (const [id, run] of cases) it(id, () => run({ store: memoryStore(), executor: referenceBatchExecutor }));

	it("registers every WAKEX and KILL-WAKEX case with an implementation", () => {
		const registry = CONFORMANCE_REGISTRY.filter(({ id }) => /^(WAKEX|KILL-WAKEX)-/.test(id));
		expect(registry).toHaveLength(13);
		expect(findImplementationGaps(registry, cases)).toEqual({ unimplemented: [], unregistered: [] });
	});
});
