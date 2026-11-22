import type { CaseImplementation } from "../../conformance/runner.ts";
import type { DurableStore, StoreOperation, StoreSnapshot } from "../store.ts";
import { append, claimedStore, put, stored } from "./store-cases.ts";
import {
	adoptLog,
	cutOnceAt,
	expectCut,
	expectEqual,
	expectStoreError,
	type StoreCaseAdapters,
	type StoreConformanceAdapter,
} from "./store-harness.ts";

/** Where a KILL case applies; a host report logs it in kill[] with the registry's expected outcome. */
export interface KillDeclaration {
	readonly id: string;
	readonly op: StoreOperation;
	readonly at: "before" | "durable";
	readonly placement: "everywhere";
}

type KillPoint = Pick<KillDeclaration, "op" | "at">;
type KillCase = KillDeclaration & { readonly run: CaseImplementation<StoreCaseAdapters> };

const killCase = (
	id: string,
	op: StoreOperation,
	at: KillPoint["at"],
	body: (adapter: StoreConformanceAdapter, kill: KillPoint) => Promise<void>,
): KillCase => ({ id, op, at, placement: "everywhere", run: ({ store }) => body(store, { op, at }) });

async function seeded(adapter: StoreConformanceAdapter) {
	const { medium, store } = await claimedStore(adapter);
	await store.commit(1, [append("r1"), put("doc", 1)], () => {});
	return { medium, baseline: await store.exportSnapshot() };
}

async function killThenReopen(
	adapter: StoreConformanceAdapter,
	medium: string,
	kill: KillPoint,
	operation: (store: DurableStore) => Promise<unknown>,
): Promise<DurableStore> {
	await expectCut(operation(await adapter.open(medium, cutOnceAt(kill))), `kill ${kill.at} ${kill.op}`);
	return adapter.open(medium);
}

const content = ({ head, records, documents }: StoreSnapshot) => ({ head, records, documents });
const SECOND_BATCH = [append("r2"), put("doc", 2)];

const KILL_CASES: readonly KillCase[] = [
	killCase("KILL-STORE-01", "commit", "before", async (adapter, kill) => {
		const { medium, baseline } = await seeded(adapter);
		const log = adoptLog();
		const restarted = await killThenReopen(adapter, medium, kill, (s) => s.commit(1, SECOND_BATCH, log.adopt));
		expectEqual(await restarted.exportSnapshot(), baseline, "nothing of the batch is durable");
		expectEqual(await restarted.commit(1, SECOND_BATCH, log.adopt), { seqs: [2], head: 2 }, "same IDs, next seq");
		expectEqual(log.calls, ["adopt:2"], "only the committed batch adopts");
	}),
	killCase("KILL-STORE-02", "commit", "durable", async (adapter, kill) => {
		const { medium, baseline } = await seeded(adapter);
		const log = adoptLog();
		const restarted = await killThenReopen(adapter, medium, kill, (s) => s.commit(1, SECOND_BATCH, log.adopt));
		const expected = {
			...baseline,
			head: 2,
			records: [stored(1, "r1"), stored(2, "r2")],
			documents: [{ key: "doc", data: 2 }],
		};
		expectEqual(log.calls, [], "the killed process never adopted");
		expectEqual(await restarted.exportSnapshot(), expected, "the whole batch is durable with its IDs and seqs");
		await expectStoreError(restarted.commit(1, SECOND_BATCH, log.adopt), "duplicate-record-id", "a retried batch");
		expectEqual(await restarted.exportSnapshot(), expected, "the retry applies nothing twice");
	}),
	killCase("KILL-STORE-03", "claim", "before", async (adapter, kill) => {
		const { medium, baseline } = await seeded(adapter);
		const restarted = await killThenReopen(adapter, medium, kill, (s) => s.claim(1, 2));
		expectEqual(await restarted.exportSnapshot(), baseline, "the epoch and log are unchanged");
		await restarted.claim(1, 2);
		expectEqual(await restarted.readEpoch(), 2, "the claim succeeds after restart");
	}),
	killCase("KILL-STORE-04", "claim", "durable", async (adapter, kill) => {
		const { medium, baseline } = await seeded(adapter);
		const restarted = await killThenReopen(adapter, medium, kill, (s) => s.claim(1, 2));
		expectEqual(
			await restarted.exportSnapshot(),
			{ ...baseline, epoch: 2 },
			"the claim is durable; the log is intact",
		);
		await expectStoreError(restarted.claim(1, 2), "stale-epoch", "the claim cannot be taken twice");
		await expectStoreError(
			restarted.commit(1, [append("late")], () => {}),
			"stale-epoch",
			"the old epoch is fenced",
		);
	}),
	killCase("KILL-STORE-05", "import", "before", async (adapter, kill) => {
		const { baseline } = await seeded(adapter);
		const { medium } = await claimedStore(adapter, 2);
		const restarted = await killThenReopen(adapter, medium, kill, (s) => s.importSnapshot(2, baseline));
		expectEqual(
			await restarted.exportSnapshot(),
			{ epoch: 2, head: 0, records: [], documents: [] },
			"nothing imported",
		);
		await restarted.importSnapshot(2, baseline);
		expectEqual(content(await restarted.exportSnapshot()), content(baseline), "the import succeeds after restart");
	}),
	killCase("KILL-STORE-06", "import", "durable", async (adapter, kill) => {
		const { baseline } = await seeded(adapter);
		const { medium } = await claimedStore(adapter, 2);
		const restarted = await killThenReopen(adapter, medium, kill, (s) => s.importSnapshot(2, baseline));
		expectEqual(content(await restarted.exportSnapshot()), content(baseline), "the whole import is durable");
		await restarted.importSnapshot(2, baseline);
		expectEqual(content(await restarted.exportSnapshot()), content(baseline), "re-import adds nothing twice");
	}),
];

export const KILL_STORE_DECLARATIONS: readonly KillDeclaration[] = KILL_CASES.map(({ id, op, at, placement }) => ({
	id,
	op,
	at,
	placement,
}));

export const KILL_STORE_CASES: ReadonlyMap<string, CaseImplementation<StoreCaseAdapters>> = new Map(
	KILL_CASES.map(({ id, run }) => [id, run]),
);
