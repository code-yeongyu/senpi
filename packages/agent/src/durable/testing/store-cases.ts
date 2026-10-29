import type { CaseImplementation } from "../../conformance/runner.ts";
import { createAdmissionLine } from "../store-admission.ts";
import type { StoreValue, StoreWrite, StoreWritePoint } from "../store.ts";
import {
	adoptLog,
	cutOnceAt,
	expectCut,
	expectEqual,
	expectStoreError,
	reopenSnapshot,
	type StoreCaseAdapters,
	type StoreConformanceAdapter,
} from "./store-harness.ts";

type StoreCase = CaseImplementation<StoreCaseAdapters>;

export const append = (id: string, kind = "entry"): StoreWrite => ({ op: "append", id, kind, data: { id } });
export const put = (key: string, data: StoreValue): StoreWrite => ({ op: "put", key, data });
export const stored = (seq: number, id: string, kind = "entry") => ({ seq, id, kind, data: { id } });

export async function claimedStore(adapter: StoreConformanceAdapter, epoch = 1) {
	const medium = await adapter.createMedium();
	const store = await adapter.open(medium);
	for (let next = 1; next <= epoch; next++) await store.claim(next - 1, next);
	return { medium, store };
}

const commitAdoptsOnDurable: StoreCase = async ({ store: adapter }) => {
	const medium = await adapter.createMedium();
	const events: string[] = [];
	const store = await adapter.open(medium, {
		onWritePoint: (point) => void (point.op === "commit" && point.at === "durable" && events.push("durable")),
	});
	await store.claim(0, 1);
	const adopt = (result: { readonly seqs: readonly number[] }) => void events.push(`adopt:${result.seqs.join(",")}`);

	expectEqual(
		await store.commit(1, [append("r1"), append("r2"), put("doc", 1)], adopt),
		{ seqs: [1, 2], head: 2 },
		"batch",
	);
	expectEqual(events, ["durable", "adopt:1,2"], "adopt runs once, after the batch is durable");
	expectEqual(await store.commit(1, [put("doc", 2)], adopt), { seqs: [], head: 2 }, "documents-only batch");
	expectEqual(
		await reopenSnapshot(adapter, medium),
		{
			epoch: 1,
			head: 2,
			records: [stored(1, "r1"), stored(2, "r2")],
			documents: [{ key: "doc", data: 2 }],
		},
		"another instance on the medium sees every committed batch whole",
	);
};

const BATCH: readonly StoreWrite[] = [append("r2"), put("a", 2), { op: "delete", key: "b" }, append("r3"), put("c", 1)];

const cutAtEveryWritePoint: StoreCase = async ({ store: adapter }) => {
	const points: StoreWritePoint[] = [
		{ op: "commit", at: "before" },
		...BATCH.map((_, index): StoreWritePoint => ({ op: "commit", at: "write", index })),
	];
	for (const point of points) {
		const what = `cut at ${JSON.stringify(point)}`;
		const { medium, store: setup } = await claimedStore(adapter);
		await setup.commit(1, [append("r1"), put("a", 1), put("b", 1)], () => {});
		const baseline = await setup.exportSnapshot();
		const store = await adapter.open(medium, cutOnceAt(point));
		const log = adoptLog();

		await expectCut(store.commit(1, BATCH, log.adopt), what);
		expectEqual(log.calls, [], `${what}: no adopt`);
		expectEqual(await reopenSnapshot(adapter, medium), baseline, `${what}: nothing of the batch is durable`);
		expectEqual(await store.commit(1, BATCH, log.adopt), { seqs: [2, 3], head: 3 }, `${what}: no seq burned`);
		expectEqual(log.calls, ["adopt:2,3"], `${what}: the retried batch adopts once`);
	}
};

const concurrentAdmissions: StoreCase = async ({ store: adapter }) => {
	const { store } = await claimedStore(adapter);
	const line = createAdmissionLine();
	const events: string[] = [];
	const gate = Promise.withResolvers<void>();
	const admit = (name: string, hold?: Promise<void>) =>
		line.admit(async () => {
			events.push(`${name}:start`);
			if (hold !== undefined) await hold;
			return store.commit(1, [append(name)], (result) => void events.push(`${name}:adopt:${result.seqs.join(",")}`));
		});

	const admissions = [
		admit("a", gate.promise),
		admit("b"),
		line.admit(async () => {
			events.push("c:start");
			throw new Error("mutation refused");
		}),
		admit("d"),
	];
	gate.resolve();
	const settled = await Promise.allSettled(admissions);

	expectEqual(
		settled.map((s) => s.status),
		["fulfilled", "fulfilled", "rejected", "fulfilled"],
		"admission outcomes",
	);
	expectEqual(
		events,
		["a:start", "a:adopt:1", "b:start", "b:adopt:2", "c:start", "d:start", "d:adopt:3"],
		"one admission at a time, in admission order; a refused mutation releases the line",
	);
	expectEqual(
		(await store.scanRecords()).map((r) => `${r.seq}:${r.id}`),
		["1:a", "2:b", "3:d"],
		"records",
	);
};

const delayedOldOwner: StoreCase = async ({ store: adapter }) => {
	const { medium, store: oldOwner } = await claimedStore(adapter);
	await oldOwner.commit(1, [append("old-1")], () => {});
	const newOwner = await adapter.open(medium);
	await newOwner.claim(1, 2);
	await newOwner.commit(2, [append("new-1")], () => {});
	const late = adoptLog();

	await expectStoreError(
		oldOwner.commit(1, [append("old-2")], late.adopt),
		"stale-epoch",
		"old owner's delayed commit",
	);
	await expectStoreError(oldOwner.claim(1, 2), "stale-epoch", "old owner's delayed claim");
	await expectStoreError(newOwner.commit(3, [append("x")], late.adopt), "stale-epoch", "a commit from a future epoch");
	await expectStoreError(newOwner.claim(2, 2), "invalid-claim", "a claim that does not raise the epoch");
	const fresh = await adapter.open(await adapter.createMedium());
	await expectStoreError(fresh.commit(0, [append("x")], late.adopt), "unclaimed", "a commit to an unclaimed store");
	expectEqual(late.calls, [], "no refused commit adopts");
	expectEqual(
		await reopenSnapshot(adapter, medium),
		{
			epoch: 2,
			head: 2,
			records: [stored(1, "old-1"), stored(2, "new-1")],
			documents: [],
		},
		"the new owner's state",
	);
};

const claimAndImport: StoreCase = async ({ store: adapter }) => {
	const { store: source } = await claimedStore(adapter);
	await source.commit(1, [append("r1"), append("r2"), put("doc", "v1")], () => {});
	const first = await source.exportSnapshot();
	const { medium, store: target } = await claimedStore(adapter, 2);

	await expectStoreError(target.importSnapshot(1, first), "stale-epoch", "import under a non-current epoch");
	await target.importSnapshot(2, first);
	await target.importSnapshot(2, first);
	expectEqual(await reopenSnapshot(adapter, medium), { ...first, epoch: 2 }, "import is whole and idempotent");

	await source.commit(1, [append("r3"), put("doc", "v2")], () => {});
	const tail = await source.exportSnapshot();
	await target.importSnapshot(2, tail);
	expectEqual(await reopenSnapshot(adapter, medium), { ...tail, epoch: 2 }, "the tail past the head is imported once");

	const conflicting = { ...tail, records: [stored(1, "r1"), stored(2, "other"), stored(3, "r3")] };
	await expectStoreError(target.importSnapshot(2, conflicting), "import-conflict", "a diverged log");
	await expectStoreError(
		target.importSnapshot(2, { ...tail, epoch: 2 }),
		"invalid-claim",
		"an import not above the source",
	);
	expectEqual(await reopenSnapshot(adapter, medium), { ...tail, epoch: 2 }, "refused imports change nothing");
	expectEqual(
		await target.commit(2, [append("r4")], () => {}),
		{ seqs: [4], head: 4 },
		"the new owner continues the log",
	);
};

const claimRaisesEpochByOne: StoreCase = async ({ store: adapter }) => {
	const { medium, store } = await claimedStore(adapter);
	await store.commit(1, [append("r1")], () => {});
	const baseline = await store.exportSnapshot();
	const fresh = await adapter.open(await adapter.createMedium());

	await expectStoreError(store.claim(1, 3), "invalid-claim", "a claim that skips an epoch");
	await expectStoreError(fresh.claim(0, 2), "invalid-claim", "a first claim that skips epoch 1");
	expectEqual(await fresh.readEpoch(), 0, "a refused first claim leaves the store unclaimed");
	expectEqual(await reopenSnapshot(adapter, medium), baseline, "a refused claim leaves the epoch and log unchanged");
	await store.claim(1, 2);
	expectEqual(await store.readEpoch(), 2, "the next epoch is still claimable");
};

const idsScansAndDocuments: StoreCase = async ({ store: adapter }) => {
	const { medium, store } = await claimedStore(adapter);
	const reopened = await adapter.open(medium);
	const elsewhere = await adapter.open(await adapter.createMedium());
	const ids = [store, reopened, elsewhere].flatMap((s) => Array.from({ length: 100 }, () => s.mintId()));
	expectEqual(new Set(ids).size, ids.length, "minted IDs are unique across instances, reopens and hosts");

	const kinds = ["a", "b", "a", "b", "a"];
	await store.commit(
		1,
		[...kinds.map((kind, i) => append(`r${i + 1}`, kind)), put("s/2", 2), put("s/1", 1), put("t/1", 3)],
		() => {},
	);
	const seqsOf = async (query: Parameters<typeof store.scanRecords>[0]) =>
		(await store.scanRecords(query)).map((r) => r.seq);
	expectEqual(await seqsOf(undefined), [1, 2, 3, 4, 5], "full scan");
	expectEqual(await seqsOf({ fromSeq: 2, toSeq: 4 }), [2, 3, 4], "range scan");
	expectEqual(await seqsOf({ kind: "b" }), [2, 4], "kind scan");
	expectEqual(await seqsOf({ order: "desc", limit: 2 }), [5, 4], "descending, limited");
	expectEqual(await seqsOf({ kind: "a", order: "desc", limit: 1 }), [5], "kind, descending, limited");

	expectEqual(
		await store.scanDocuments("s/"),
		[
			{ key: "s/1", data: 1 },
			{ key: "s/2", data: 2 },
		],
		"prefix scan",
	);
	await store.commit(1, [{ op: "delete", key: "s/1" }], () => {});
	expectEqual(await store.getDocument("s/1"), undefined, "a deleted document");
	expectEqual(
		(await store.scanDocuments("")).map((d) => d.key),
		["s/2", "t/1"],
		"all documents by key",
	);

	await expectStoreError(
		store.commit(1, [append("r1")], () => {}),
		"duplicate-record-id",
		"an ID already in the log",
	);
	await expectStoreError(
		store.commit(1, [append("x"), append("x")], () => {}),
		"duplicate-record-id",
		"a repeated ID",
	);
	expectEqual(await store.readHead(), 5, "refused batches change nothing");

	const value = { nested: { n: 1 } };
	await store.commit(1, [put("v", value)], () => {});
	value.nested.n = 2;
	const read = await store.getDocument("v");
	expectEqual(read, { nested: { n: 1 } }, "the store keeps its own copy of written values");
};

export const STORE_CASES: ReadonlyMap<string, StoreCase> = new Map([
	["STORE-01", commitAdoptsOnDurable],
	["STORE-02", cutAtEveryWritePoint],
	["STORE-03", concurrentAdmissions],
	["STORE-04", delayedOldOwner],
	["STORE-05", claimAndImport],
	["STORE-06", idsScansAndDocuments],
	["STORE-07", claimRaisesEpochByOne],
]);
