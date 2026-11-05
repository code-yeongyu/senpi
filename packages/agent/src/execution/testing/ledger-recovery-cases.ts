import type { CaseImplementation } from "../../conformance/runner.ts";
import { expectEqual, expectStoreError, type StoreCaseAdapters } from "../../durable/testing/store-harness.ts";
import { MAX_EXECUTION_LIFETIME_MS } from "../ledger-types.ts";
import {
	accepted,
	ADMISSION,
	command,
	DISPATCH,
	fixture,
	FROZEN,
	ledgerOn,
	PREPARE,
	row,
	runEvents,
} from "./ledger-harness.ts";

type LedgerCase = CaseImplementation<StoreCaseAdapters>;
const renewal: LedgerCase = async ({ store }) => {
	const { ledger } = await fixture(store);
	const renew = { kind: "renew", seq: 1, leaseUntil: 100_000 } as const;
	expectEqual(
		await ledger.apply({ ...command(renew), actor: { id: "hand" } }),
		{ status: "refused", reason: "unauthorized" },
		"issuer-only renewal",
	);
	expectEqual((await ledger.apply(command(renew))).status, "applied", "renewal starts at admission");
	expectEqual((await ledger.apply(command(renew))).status, "replayed", "duplicate renewal");
	expectEqual(
		await ledger.apply(
			command({ ...renew, seq: 2, leaseUntil: ADMISSION.admittedAt + MAX_EXECUTION_LIFETIME_MS + 1 }),
		),
		{ status: "refused", reason: "invalid_renewal" },
		"24-hour cap",
	);
	expectEqual(
		await ledger.apply(command({ ...renew, seq: 2, leaseUntil: 90_000 })),
		{ status: "refused", reason: "invalid_renewal" },
		"lease cannot shrink",
	);
	await ledger.apply(command({ kind: "cancel" }));
	const terminal = await row(ledger);
	expectEqual(
		accepted(await ledger.apply(command({ ...renew, seq: 3 }))),
		terminal,
		"terminal renewal returns stored outcome",
	);
};

const acknowledgement: LedgerCase = async ({ store }) => {
	const { ledger, reopen } = await fixture(store);
	expectEqual(
		await ledger.apply(command({ kind: "ack" })),
		{ status: "refused", reason: "invalid_transition" },
		"early ACK",
	);
	await ledger.apply(command({ kind: "cancel" }));
	expectEqual(
		await ledger.apply({ ...command({ kind: "ack" }), actor: { id: "other" } }),
		{ status: "refused", reason: "unauthorized" },
		"issuer-only ACK",
	);
	await ledger.apply(command({ kind: "ack" }));
	const reopened = await reopen();
	expectEqual((await reopened.apply(command({ kind: "ack" }))).status, "replayed", "duplicate ACK");
	expectEqual(await reopened.admit(ADMISSION), { status: "result_expired" }, "dedup after ACK");
	expectEqual((await row(reopened)).progress, { state: "acked" }, "payload removed, identity retained");
};

const preparingRestart: LedgerCase = async ({ store }) => {
	for (const effects of [false, true]) {
		const { ledger, reopen } = await fixture(store);
		await runEvents(ledger, PREPARE.slice(0, effects ? 2 : 1));
		const reopened = await reopen();
		await reopened.recover(102);
		expectEqual(
			(await row(reopened)).progress,
			{
				state: "settled",
				outcome: { reason: "hand_restarted", hooksRan: effects, uncertain: effects },
			},
			"preparing never reruns after restart",
		);
		expectEqual(
			(await reopened.apply(command({ kind: "prepare" }, 103))).status,
			"replayed",
			"no new preparation permission",
		);
	}
};

const preparedRestart: LedgerCase = async ({ store }) => {
	for (const state of ["prepared", "prepared_awaiting_consent", "released"] as const) {
		const { ledger, reopen } = await fixture(store);
		await runEvents(ledger, [
			...PREPARE.slice(0, 2),
			{ kind: "freeze", call: FROZEN, awaitingConsent: state === "prepared_awaiting_consent" },
		]);
		if (state === "released") await ledger.apply(command({ kind: "release" }));
		const reopened = await reopen();
		await reopened.recover(102);
		expectEqual((await row(reopened)).progress, { state, call: FROZEN }, "frozen state survives restart");
	}
};

const reconciliation: LedgerCase = async ({ store }) => {
	for (const reconcilable of [false, true]) {
		const { ledger, reopen } = await fixture(store, { ...ADMISSION, reconcilable });
		await runEvents(ledger, DISPATCH);
		const reopened = await reopen();
		await reopened.recover(102);
		if (!reconcilable) {
			expectEqual(
				(await row(reopened)).progress,
				{ state: "settled", outcome: { reason: "hand_restarted", hooksRan: true, uncertain: true } },
				"unreconcilable dispatch",
			);
			continue;
		}
		expectEqual(
			(await row(reopened)).progress,
			{ state: "reconciling", call: FROZEN, until: 30_102 },
			"30-second grace",
		);
		await reopened.recover(103);
		expectEqual(
			(await row(reopened)).progress,
			{ state: "reconciling", call: FROZEN, until: 30_102 },
			"another restart cannot extend grace",
		);
		await reopened.apply(command({ kind: "expire" }, 30_102));
		expectEqual((await row(reopened)).progress.state, "settled", "grace deadline settles without dispatching again");
	}
	const { ledger, reopen } = await fixture(store, { ...ADMISSION, reconcilable: true });
	await runEvents(ledger, DISPATCH);
	const restarted = await reopen();
	await restarted.recover(102);
	await restarted.apply(command({ kind: "result", value: "reconciled" }, 103));
	expectEqual(
		(await row(restarted)).progress,
		{ state: "settled", outcome: { reason: "result", value: "reconciled", hooksRan: true, uncertain: false } },
		"authoritative reconciliation resolves uncertainty",
	);
};

const expiryAndFencing: LedgerCase = async ({ store }) => {
	const { ledger, store: durable, medium } = await fixture(store);
	await runEvents(ledger, PREPARE);
	const expired = accepted(await ledger.apply(command({ kind: "release" }, ADMISSION.leaseUntil)));
	expectEqual(
		expired.progress,
		{ state: "settled", outcome: { reason: "lease_expired", hooksRan: true, uncertain: true } },
		"lease reason retained at boundary",
	);
	const next = await store.open(medium);
	await next.claim(1, 2);
	await expectStoreError(ledger.admit({ ...ADMISSION, commandId: "old" }), "stale-epoch", "old owner cannot admit");
	const current = ledgerOn(next, 2);
	expectEqual((await current.admit({ ...ADMISSION, commandId: "new" })).status, "applied", "new owner");
	expectEqual(await durable.readEpoch(), 2, "fence shared by reopened instances");
	const { ledger: concurrent } = await fixture(store);
	const results = await Promise.all([
		concurrent.apply(command({ kind: "prepare" })),
		concurrent.apply(command({ kind: "prepare" })),
	]);
	expectEqual(
		results.map((reply) => reply.status),
		["applied", "replayed"],
		"one preparation grant under concurrency",
	);
	expectEqual(
		await concurrent.apply({ ...command({ kind: "cancel" }), actor: { id: "approver", approvedWorkspace: "wrong" } }),
		{ status: "refused", reason: "unauthorized" },
		"approval cannot cross workspaces",
	);
	expectEqual(
		(
			await concurrent.apply({
				...command({ kind: "cancel" }),
				actor: { id: "approver", approvedWorkspace: ADMISSION.workspace },
			})
		).status,
		"applied",
		"workspace approver may cancel",
	);
};

export const LEDGER_RECOVERY_CASES: ReadonlyMap<string, LedgerCase> = new Map([
	["LEDGER-07", renewal],
	["LEDGER-08", acknowledgement],
	["LEDGER-09", preparingRestart],
	["LEDGER-10", preparedRestart],
	["LEDGER-11", reconciliation],
	["LEDGER-12", expiryAndFencing],
]);
