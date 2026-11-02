import type { CaseImplementation } from "../../conformance/runner.ts";
import { expectEqual, type StoreCaseAdapters } from "../../durable/testing/store-harness.ts";
import { ADMISSION, command, DISPATCH, fixture, FROZEN, PREPARE, row, runEvents } from "./ledger-harness.ts";
import { LEDGER_RECOVERY_CASES } from "./ledger-recovery-cases.ts";

type LedgerCase = CaseImplementation<StoreCaseAdapters>;

const identity: LedgerCase = async ({ store }) => {
	const { ledger } = await fixture(store);
	expectEqual((await ledger.admit(ADMISSION)).status, "replayed", "same identity");
	for (const change of [{ scope: "other" }, { generation: 2 }, { requestDigest: "changed" }, { executor: "other" }]) {
		expectEqual(
			await ledger.admit({ ...ADMISSION, ...change }),
			{ status: "refused", reason: "identity_conflict" },
			"binding",
		);
	}
	expectEqual(
		(await ledger.admit({ ...ADMISSION, issuer: "another" })).status,
		"applied",
		"issuer namespaces identity",
	);
	expectEqual(
		await ledger.apply({ ...command({ kind: "prepare" }), generation: 2 }),
		{ status: "refused", reason: "stale_generation" },
		"generation fence",
	);
};

const preparation: LedgerCase = async ({ store }) => {
	const { ledger, reopen } = await fixture(store);
	expectEqual(
		await ledger.apply(command({ kind: "effect" })),
		{ status: "refused", reason: "invalid_transition" },
		"no effects before prepare",
	);
	await ledger.apply(command({ kind: "prepare" }));
	expectEqual(
		await ledger.apply(command({ kind: "freeze", call: FROZEN, awaitingConsent: false })),
		{ status: "refused", reason: "invalid_transition" },
		"freeze requires effect marker",
	);
	await ledger.apply(command({ kind: "effect" }));
	expectEqual(
		(await row(await reopen())).effectPossible,
		true,
		"effect marker survives reopen before a callback may run",
	);
	expectEqual((await ledger.apply(command({ kind: "effect" }))).status, "replayed", "effects never granted twice");
	await ledger.apply(command({ kind: "freeze", call: FROZEN, awaitingConsent: false }));
	expectEqual(
		(await row(await reopen())).progress,
		{ state: "prepared", call: FROZEN },
		"frozen bytes survive reopen",
	);
};

const consent: LedgerCase = async ({ store }) => {
	const { ledger } = await fixture(store);
	await runEvents(ledger, [...PREPARE.slice(0, 2), { kind: "freeze", call: FROZEN, awaitingConsent: true }]);
	expectEqual(
		await ledger.apply(command({ kind: "release" })),
		{ status: "refused", reason: "invalid_transition" },
		"consent wait cannot release",
	);
	expectEqual(
		await ledger.apply({ ...command({ kind: "consent" }), actor: { id: "other" } }),
		{ status: "refused", reason: "unauthorized" },
		"consent issuer",
	);
	await runEvents(ledger, [{ kind: "consent" }, { kind: "release" }, { kind: "dispatch" }]);
	expectEqual(
		(await row(ledger)).progress,
		{ state: "dispatched", call: FROZEN },
		"consent releases the frozen call without preparation",
	);
};

const dispatch: LedgerCase = async ({ store }) => {
	const { ledger, reopen } = await fixture(store);
	expectEqual(
		await ledger.apply(command({ kind: "dispatch" })),
		{ status: "refused", reason: "invalid_transition" },
		"no dispatch without release",
	);
	await runEvents(ledger, DISPATCH);
	expectEqual(
		(await (await reopen()).apply(command({ kind: "dispatch" }))).status,
		"replayed",
		"durable dispatch is never granted twice",
	);
	expectEqual((await ledger.admit(ADMISSION)).status, "replayed", "invoke replay");
};

const cancelFirst: LedgerCase = async ({ store }) => {
	for (const before of [[], PREPARE.slice(0, 2), DISPATCH]) {
		const { ledger, store: durable, reopen } = await fixture(store);
		await runEvents(ledger, before);
		await ledger.apply(command({ kind: "cancel" }));
		const terminal = await row(ledger);
		expectEqual(
			terminal.progress,
			{
				state: "settled",
				outcome: { reason: "cancelled", hooksRan: before.length > 0, uncertain: before.length > 0 },
			},
			"cancel projection follows the effect boundary",
		);
		await ledger.apply(command({ kind: "result", value: "late" }));
		expectEqual(await row(await reopen()), terminal, "late result cannot replace cancellation");
		expectEqual((await durable.scanRecords({ kind: "execution.audit" })).length, 1, "late result is audited");
	}
};

const resultFirst: LedgerCase = async ({ store }) => {
	const { ledger, reopen } = await fixture(store);
	await runEvents(ledger, DISPATCH);
	await ledger.apply(command({ kind: "result", value: { content: "done" } }));
	const terminal = await row(ledger);
	await ledger.apply(command({ kind: "cancel" }));
	expectEqual(await row(await reopen()), terminal, "result-first is immutable");
	for (const kind of ["release", "abort", "consent"] as const) {
		expectEqual(
			await ledger.apply(command({ kind })),
			{ status: "refused", reason: "terminal" },
			`${kind} on terminal`,
		);
	}
};

export const LEDGER_CASES: ReadonlyMap<string, LedgerCase> = new Map([
	["LEDGER-01", identity],
	["LEDGER-02", preparation],
	["LEDGER-03", consent],
	["LEDGER-04", dispatch],
	["LEDGER-05", cancelFirst],
	["LEDGER-06", resultFirst],
	...LEDGER_RECOVERY_CASES,
]);
