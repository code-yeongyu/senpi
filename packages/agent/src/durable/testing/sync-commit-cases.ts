import type { CaseImplementation } from "../../conformance/runner.ts";
import type { RegisteredCase } from "../../conformance/registry.ts";
import type { DurableStoreErrorCode, DurableStoreOptions, StoreWrite, StoreWritePoint, SyncCommitStore } from "../store.ts";
import { DurableStoreError } from "../store.ts";
import { adoptLog, cutOnceAt, expectEqual, reopenSnapshot } from "./store-harness.ts";
import { append, put, stored } from "./store-cases.ts";

/** What a backend that offers `commitSync` provides to the SYNC-COMMIT cases. */
export interface SyncCommitConformanceAdapter {
	createMedium(): Promise<string>;
	open(medium: string, options?: DurableStoreOptions): Promise<SyncCommitStore>;
}

export interface SyncCommitCaseAdapters {
	readonly store: SyncCommitConformanceAdapter;
}

type SyncCommitCase = CaseImplementation<SyncCommitCaseAdapters>;

async function claimed(adapter: SyncCommitConformanceAdapter, options?: DurableStoreOptions) {
	const medium = await adapter.createMedium();
	const setup = await adapter.open(medium);
	await setup.claim(0, 1);
	await setup.commit(1, [append("r1"), put("a", 1)], () => {});
	return { medium, store: await adapter.open(medium, options) };
}

function sameCallOutcome(call: () => unknown): { readonly threw: unknown } | { readonly returned: unknown } {
	try {
		return { returned: call() };
	} catch (error) {
		return { threw: error };
	}
}

const isThenable = (value: unknown): boolean =>
	typeof value === "object" && value !== null && typeof Reflect.get(value, "then") === "function";

const commitsWholeOnReturn: SyncCommitCase = async ({ store: adapter }) => {
	const { medium, store } = await claimed(adapter);
	const log = adoptLog();

	const outcome = sameCallOutcome(() => store.commitSync(1, [append("r2"), put("a", 2)], log.adopt));

	if (!("returned" in outcome)) throw new Error(`a valid sync commit threw: ${String(outcome.threw)}`);
	if (isThenable(outcome.returned)) throw new Error("commitSync returned a promise: it is not synchronous");
	expectEqual(outcome.returned, { seqs: [2], head: 2 }, "the result is the batch's seqs and the new head");
	expectEqual(log.calls, ["adopt:2"], "adopt ran once, before commitSync returned");
	expectEqual(
		await reopenSnapshot(adapter, medium),
		{ epoch: 1, head: 2, records: [stored(1, "r1"), stored(2, "r2")], documents: [{ key: "a", data: 2 }] },
		"another instance on the medium sees the batch as soon as commitSync returns",
	);
};

const BATCH: readonly StoreWrite[] = [append("r2"), put("a", 2), { op: "delete", key: "a" }, append("r3")];

type Refusal = {
	readonly what: string;
	readonly epoch: number;
	readonly writes: readonly StoreWrite[];
	readonly options?: DurableStoreOptions;
	readonly expected: DurableStoreErrorCode | "cut";
};

const REFUSALS: readonly Refusal[] = [
	{ what: "stale epoch", epoch: 2, writes: BATCH, expected: "stale-epoch" },
	{ what: "duplicate record id", epoch: 1, writes: [append("r2"), append("r1")], expected: "duplicate-record-id" },
	{ what: "cut before", epoch: 1, writes: BATCH, options: cutOnceAt({ op: "commit", at: "before" }), expected: "cut" },
	...BATCH.map(
		(_, index): Refusal => ({
			what: `cut at write ${index}`,
			epoch: 1,
			writes: BATCH,
			options: cutOnceAt({ op: "commit", at: "write", index } satisfies StoreWritePoint),
			expected: "cut",
		}),
	),
];

const refusedThrowsOnTheSameCall: SyncCommitCase = async ({ store: adapter }) => {
	for (const refusal of REFUSALS) {
		const { medium, store } = await claimed(adapter, refusal.options);
		const before = await reopenSnapshot(adapter, medium);
		const log = adoptLog();

		const outcome = sameCallOutcome(() => store.commitSync(refusal.epoch, refusal.writes, log.adopt));

		if (!("threw" in outcome)) {
			throw new Error(`${refusal.what}: the refused sync commit did not throw on the same call`);
		}
		const code = outcome.threw instanceof DurableStoreError ? outcome.threw.code : "cut";
		expectEqual(code, refusal.expected, `${refusal.what}: the refusal`);
		expectEqual(log.calls, [], `${refusal.what}: no adopt`);
		expectEqual(await reopenSnapshot(adapter, medium), before, `${refusal.what}: the store is unchanged`);
	}
};

export const SYNC_COMMIT_CASES: ReadonlyMap<string, SyncCommitCase> = new Map([
	["SYNC-COMMIT-01", commitsWholeOnReturn],
	["SYNC-COMMIT-02", refusedThrowsOnTheSameCall],
]);

const SYNC_COMMIT_IMPL = "packages/agent/src/durable/testing/sync-commit-cases.ts";

/**
 * The SYNC-COMMIT cases, run only by backends that offer `commitSync` (memory, Bun SQLite). They are kept out of the
 * cross-host CONFORMANCE_REGISTRY: a Durable Object store commits durably only asynchronously and offers no sync commit.
 */
export const SYNC_COMMIT_REGISTRY: readonly RegisteredCase[] = [
	{
		id: "SYNC-COMMIT-01",
		impl: SYNC_COMMIT_IMPL,
		intro: "#5827",
		adapters: ["store"],
		expected: "a sync commit is durable, adopted once and visible to another instance when it returns",
	},
	{
		id: "SYNC-COMMIT-02",
		impl: SYNC_COMMIT_IMPL,
		intro: "#5827",
		adapters: ["store"],
		expected: "a refused sync commit (stale epoch, duplicate id, cut) throws on the same call and changes nothing",
	},
];
