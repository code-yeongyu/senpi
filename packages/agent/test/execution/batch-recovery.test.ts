// senpi#5416 (S10): the batch coordinator's recovery cases (BATCH, REPLAY, KILL-BATCH) on the memory store.
import { describe, expect, it } from "vitest";
import { findImplementationGaps } from "../../src/conformance/mapping.ts";
import { CONFORMANCE_REGISTRY } from "../../src/conformance/registry.ts";
import { createAdmissionLine } from "../../src/durable/store-admission.ts";
import { createMemoryStoreMedium, type MemoryStoreMedium, openMemoryStore } from "../../src/durable/store-memory.ts";
import type { StoreConformanceAdapter } from "../../src/durable/testing/store-harness.ts";
import { BatchManifestConflictError, createBatchCoordinator } from "../../src/execution/coordinator.ts";
import { batchDependencies } from "../../src/execution/coordinator-plan.ts";
import type { BatchExecutor } from "../../src/execution/coordinator-types.ts";
import { BATCH_CASES } from "../../src/execution/testing/batch-cases.ts";
import { referenceBatchExecutor } from "../../src/execution/testing/batch-executor.ts";
import { KILL_BATCH_CASES } from "../../src/execution/testing/kill-batch.ts";

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

const cases = new Map([...BATCH_CASES, ...KILL_BATCH_CASES]);

describe("batch coordinator conformance on the memory store", () => {
	for (const [id, run] of cases) {
		it(id, async () => {
			await run({ store: memoryStore(), executor: referenceBatchExecutor });
		});
	}

	it("has a runnable implementation for every registered BATCH, REPLAY and KILL-BATCH case", () => {
		const registry = CONFORMANCE_REGISTRY.filter(({ id }) => /^(BATCH|REPLAY|KILL-BATCH)-/.test(id));
		expect(findImplementationGaps(registry, cases)).toEqual({ unimplemented: [], unregistered: [] });
		expect(registry.filter(({ id }) => id.startsWith("BATCH-")).map(({ id }) => id)).toEqual([
			"BATCH-01",
			"BATCH-02",
			"BATCH-03",
			"BATCH-05",
			"BATCH-06",
			"BATCH-07",
			"BATCH-08",
			"BATCH-09",
		]);
		expect(registry.filter(({ id }) => id.startsWith("REPLAY-")).map(({ id }) => id)).toEqual([
			"REPLAY-01",
			"REPLAY-02",
		]);
	});
});

describe("batchDependencies", () => {
	// Today's scheduler (agent-loop.ts executeToolCallsParallel): a sequential call waits for the previous sequential call
	// and every parallel call since; a parallel call waits for the previous sequential call only.
	const rows: ReadonlyArray<{ name: string; sequential: boolean[]; dependsOn: number[][]; waves: number[] }> = [
		{ name: "all parallel", sequential: [false, false, false], dependsOn: [[], [], []], waves: [0, 0, 0] },
		{ name: "all sequential", sequential: [true, true, true], dependsOn: [[], [0], [1]], waves: [0, 1, 2] },
		{
			name: "parallel, parallel, sequential, parallel",
			sequential: [false, false, true, false],
			dependsOn: [[], [], [0, 1], [2]],
			waves: [0, 0, 1, 2],
		},
		{
			name: "sequential first, then a parallel wave, then sequential",
			sequential: [true, false, false, true, true],
			dependsOn: [[], [0], [0], [0, 1, 2], [3]],
			waves: [0, 1, 1, 2, 3],
		},
	];
	for (const row of rows) {
		it(`mirrors today's scheduler: ${row.name}`, () => {
			const deps = batchDependencies(row.sequential.map((sequential) => ({ sequential })));
			expect(deps.map((d) => d.dependsOn)).toEqual(row.dependsOn);
			expect(deps.map((d) => d.wave)).toEqual(row.waves);
		});
	}
});

describe("a raw settled blocked outcome as a prepare reply", () => {
	it("fails closed: the ledger cannot tell a blocked call from a preflight abort, so the batch is ABORTed unrun", async () => {
		// Given: an executor that forwards the raw durable `blocked` ledger outcome instead of `blocked`/`batch_abort`
		const adapter = memoryStore();
		const store = await adapter.open(await adapter.createMedium());
		await store.claim(0, 1);
		const blocked = { reason: "blocked", value: "denied", hooksRan: true, uncertain: false } as const;
		const released: string[] = [];
		const prepared: string[] = [];
		const executor: BatchExecutor = {
			prepare: async ({ executionId }) => {
				prepared.push(executionId);
				return executionId === "a"
					? { kind: "settled", outcome: blocked }
					: { kind: "prepared", frozenDigest: "b" };
			},
			release: async ({ executionId }) => {
				released.push(executionId);
				return { kind: "settled", outcome: { reason: "result", value: "ok", hooksRan: true, uncertain: false } };
			},
			abort: async () => ({ kind: "settled", outcome: blocked }),
		};
		const coordinator = createBatchCoordinator({
			issuer: "brain",
			store,
			epoch: 1,
			admission: createAdmissionLine(),
			executor: () => executor,
		});
		const call = { executor: "hand", name: "read", args: {}, sequential: false };

		// When: the batch runs
		const result = await coordinator.run({
			batchId: "blocked-durable",
			scope: "scope",
			workspace: "workspace",
			generation: 1,
			admittedAt: 100,
			leaseUntil: 60_100,
			calls: [
				{ ...call, executionId: "a" },
				{ ...call, executionId: "b" },
			],
		});

		// Then: the batch is ABORTed, b is never prepared, and no body runs
		expect(result).toEqual({
			decision: "ABORT",
			outcomes: [
				{ kind: "blocked", result: "denied" },
				{ kind: "not_run", cause: "interrupted_preparation" },
			],
		});
		expect(prepared).toEqual(["a"]);
		expect(released).toEqual([]);
	});
});

describe("the batch manifest identity", () => {
	it("refuses a re-sent batch id whose manifest differs, before any prepare is sent", async () => {
		// Given: a batch whose manifest is durable
		const adapter = memoryStore();
		const medium = await adapter.createMedium();
		const store = await adapter.open(medium);
		await store.claim(0, 1);
		const prepared: string[] = [];
		const executor: BatchExecutor = {
			prepare: async (request) => {
				prepared.push(request.executionId);
				return { kind: "batch_abort" };
			},
			release: async () => ({ kind: "unknown_execution" }),
			abort: async () => ({ kind: "unknown_execution" }),
		};
		const coordinator = createBatchCoordinator({
			issuer: "brain",
			store,
			epoch: 1,
			admission: createAdmissionLine(),
			executor: () => executor,
		});
		const plan = {
			batchId: "batch",
			scope: "scope",
			workspace: "workspace",
			generation: 1,
			admittedAt: 100,
			leaseUntil: 60_100,
			calls: [{ executionId: "a", executor: "hand", name: "read", args: { path: "a" }, sequential: false }],
		};
		await coordinator.run(plan);

		// When: the same batch id arrives with different arguments
		const changed = { ...plan, calls: [{ ...plan.calls[0], args: { path: "b" } }] };

		// Then: it is refused and no prepare is sent for it
		await expect(coordinator.run(changed)).rejects.toBeInstanceOf(BatchManifestConflictError);
		expect(prepared).toEqual(["a"]);
	});
});
