import type { CaseImplementation } from "../../conformance/runner.ts";
import type { StoreWritePoint } from "../../durable/store.ts";
import { claimedStore } from "../../durable/testing/store-cases.ts";
import { cutOnceAt, expectCut, expectEqual, type StoreCaseAdapters } from "../../durable/testing/store-harness.ts";
import type { ExecutionEvent, ExecutionProgress } from "../ledger-types.ts";
import { ADMISSION, command, DISPATCH, FROZEN, ledgerOn, PREPARE, runEvents } from "./ledger-harness.ts";

type Transition = {
	readonly name: string;
	readonly before: readonly ExecutionEvent[];
	readonly event?: ExecutionEvent;
	readonly now?: number;
	readonly reconcilable?: boolean;
	readonly expected: ExecutionProgress["state"];
};
const TRANSITIONS: readonly Transition[] = [
	{ name: "admit", before: [], expected: "admitted" },
	{ name: "prepare", before: [], event: { kind: "prepare" }, expected: "preparing" },
	{ name: "effect", before: PREPARE.slice(0, 1), event: { kind: "effect" }, expected: "preparing" },
	{
		name: "freeze",
		before: PREPARE.slice(0, 2),
		event: { kind: "freeze", call: FROZEN, awaitingConsent: false },
		expected: "prepared",
	},
	{
		name: "await-consent",
		before: PREPARE.slice(0, 2),
		event: { kind: "freeze", call: FROZEN, awaitingConsent: true },
		expected: "prepared_awaiting_consent",
	},
	{
		name: "consent",
		before: [...PREPARE.slice(0, 2), { kind: "freeze", call: FROZEN, awaitingConsent: true }],
		event: { kind: "consent" },
		expected: "prepared",
	},
	{ name: "release", before: PREPARE, event: { kind: "release" }, expected: "released" },
	{ name: "dispatch", before: DISPATCH.slice(0, 4), event: { kind: "dispatch" }, expected: "dispatched" },
	{ name: "result", before: DISPATCH, event: { kind: "result", value: "done" }, expected: "settled" },
	{ name: "cancel", before: DISPATCH, event: { kind: "cancel" }, expected: "settled" },
	{ name: "abort", before: PREPARE, event: { kind: "abort" }, expected: "settled" },
	{ name: "renew", before: [], event: { kind: "renew", seq: 1, leaseUntil: 70_100 }, expected: "admitted" },
	{ name: "expire", before: PREPARE, event: { kind: "expire" }, now: 60_100, expected: "settled" },
	{ name: "restart", before: PREPARE.slice(0, 2), event: { kind: "restart" }, expected: "settled" },
	{ name: "reconcile", before: DISPATCH, event: { kind: "restart" }, reconcilable: true, expected: "reconciling" },
	{ name: "ack", before: [...DISPATCH, { kind: "result", value: "done" }], event: { kind: "ack" }, expected: "acked" },
];
const POINTS: readonly StoreWritePoint[] = [
	{ op: "commit", at: "before" },
	{ op: "commit", at: "write", index: 0 },
	{ op: "commit", at: "write", index: 1 },
	{ op: "commit", at: "durable" },
];

export interface KillLedgerDeclaration {
	readonly id: string;
	readonly operation: string;
	readonly point: StoreWritePoint;
	readonly placement: "everywhere";
}
const cases = TRANSITIONS.flatMap((transition, index) =>
	POINTS.map((point, cutIndex) => {
		const id = `KILL-LEDGER-${String(index + 1).padStart(2, "0")}-${cutIndex + 1}`;
		const run: CaseImplementation<StoreCaseAdapters> = async ({ store: adapter }) => {
			const { medium, store } = await claimedStore(adapter);
			const ledger = ledgerOn(store);
			const input = { ...ADMISSION, reconcilable: transition.reconcilable ?? false };
			if (transition.event !== undefined) await ledger.admit(input);
			await runEvents(ledger, transition.before);
			const baseline = await store.exportSnapshot();
			const cut = ledgerOn(await adapter.open(medium, cutOnceAt(point)));
			await expectCut(
				transition.event === undefined ? cut.admit(input) : cut.apply(command(transition.event, transition.now)),
				`${transition.name}/${point.at}`,
			);
			const reopenedStore = await adapter.open(medium);
			const reopened = ledgerOn(reopenedStore);
			const snapshot = await reopenedStore.exportSnapshot();
			if (point.at !== "durable") {
				expectEqual(snapshot, baseline, "a cut before durable changes neither journal nor row");
			} else {
				expectEqual(snapshot.head, baseline.head + 1, "exactly one durable transition");
				const entry = await reopened.read(ADMISSION);
				expectEqual(entry?.progress.state, transition.expected, "the complete endpoint transition survived");
				if (transition.name === "effect")
					expectEqual(entry?.effectPossible, true, "effect permission durable before callback");
				if (transition.name === "dispatch") {
					expectEqual(entry?.bodyDispatched, true, "dispatch permission is durable before body");
					expectEqual(
						(await reopened.apply(command({ kind: "dispatch" }))).status,
						"replayed",
						"no second dispatch after crash",
					);
				}
				if (transition.name === "renew") expectEqual(entry?.renewSeq, 1, "renewal sequence survives");
			}
			await reopened.recover(transition.now ?? 102);
			const recovered = await reopened.read(ADMISSION);
			if (recovered?.progress.state === "preparing" || recovered?.progress.state === "dispatched") {
				throw new Error("restart left a non-resumable execution live");
			}
			if (recovered !== undefined) {
				const replay = await reopened.admit(input);
				expectEqual(
					replay.status,
					recovered.progress.state === "acked" ? "result_expired" : "replayed",
					"identity survives restart",
				);
			}
		};
		return { id, operation: transition.name, point, placement: "everywhere" as const, run };
	}),
);

export const KILL_LEDGER_DECLARATIONS: readonly KillLedgerDeclaration[] = cases.map(({ run: _run, ...entry }) => entry);
export const KILL_LEDGER_CASES: ReadonlyMap<string, CaseImplementation<StoreCaseAdapters>> = new Map(
	cases.map(({ id, run }) => [id, run]),
);
