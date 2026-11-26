import { describe, expect, it } from "vitest";
import { findImplementationGaps } from "../../src/conformance/mapping.ts";
import { CONFORMANCE_REGISTRY } from "../../src/conformance/registry.ts";
import { createMemoryStoreMedium, type MemoryStoreMedium, openMemoryStore } from "../../src/durable/store-memory.ts";
import type { StoreConformanceAdapter } from "../../src/durable/testing/store-harness.ts";
import { KILL_LEDGER_CASES } from "../../src/execution/testing/kill-ledger.ts";
import { LEDGER_CASES } from "../../src/execution/testing/ledger-cases.ts";

function adapter(): StoreConformanceAdapter {
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

const cases = new Map([...LEDGER_CASES, ...KILL_LEDGER_CASES]);
describe("portable execution ledger conformance", () => {
	for (const [id, run] of cases) {
		it(id, async () => {
			await run({ store: adapter() });
		});
	}
	it("has a runnable implementation for every registered ledger obligation", () => {
		const registry = CONFORMANCE_REGISTRY.filter(({ id }) => /^(KILL-)?LEDGER-/.test(id));
		expect(findImplementationGaps(registry, cases)).toEqual({ unimplemented: [], unregistered: [] });
		expect(registry.filter(({ id }) => id.startsWith("LEDGER-"))).toHaveLength(12);
	});
});
