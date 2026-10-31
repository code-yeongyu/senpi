import { createAdmissionLine } from "../../durable/store-admission.ts";
import type { DurableStore, DurableStoreOptions } from "../../durable/store.ts";
import { claimedStore } from "../../durable/testing/store-cases.ts";
import { expectEqual, type StoreConformanceAdapter } from "../../durable/testing/store-harness.ts";
import { createExecutionLedger, type ExecutionLedger } from "../ledger.ts";
import type {
	ExecutionAdmission,
	ExecutionCommand,
	ExecutionEntry,
	ExecutionEvent,
	LedgerReply,
} from "../ledger-types.ts";

export const ADMISSION: ExecutionAdmission = {
	issuer: "brain",
	commandId: "call",
	executor: "hand",
	workspace: "workspace",
	scope: "scope",
	generation: 1,
	requestDigest: "raw",
	admittedAt: 100,
	leaseUntil: 60_100,
	reconcilable: false,
};
export const FROZEN = { name: "read", args: { path: "a" }, digest: "frozen" } as const;
export const PREPARE: readonly ExecutionEvent[] = [
	{ kind: "prepare" },
	{ kind: "effect" },
	{ kind: "freeze", call: FROZEN, awaitingConsent: false },
];
export const DISPATCH: readonly ExecutionEvent[] = [...PREPARE, { kind: "release" }, { kind: "dispatch" }];

export function command(event: ExecutionEvent, now = 101): ExecutionCommand {
	const issuer = ["consent", "release", "abort", "ack", "renew", "cancel"].includes(event.kind);
	return { key: ADMISSION, generation: 1, actor: { id: issuer ? "brain" : "hand" }, now, event };
}

export function accepted(reply: LedgerReply): ExecutionEntry {
	if (reply.status !== "applied" && reply.status !== "replayed") {
		throw new Error(`expected an execution row, got ${JSON.stringify(reply)}`);
	}
	return reply.entry;
}

export function ledgerOn(store: DurableStore, epoch = 1): ExecutionLedger {
	return createExecutionLedger({ store, epoch, admission: createAdmissionLine() });
}

export async function fixture(adapter: StoreConformanceAdapter, input: ExecutionAdmission = ADMISSION) {
	const { medium, store } = await claimedStore(adapter);
	const ledger = ledgerOn(store);
	expectEqual((await ledger.admit(input)).status, "applied", "admitted");
	return {
		medium,
		store,
		ledger,
		reopen: async (options?: DurableStoreOptions) => ledgerOn(await adapter.open(medium, options)),
	};
}

export async function runEvents(ledger: ExecutionLedger, events: readonly ExecutionEvent[]): Promise<void> {
	for (const event of events) expectEqual((await ledger.apply(command(event))).status, "applied", event.kind);
}

export async function row(ledger: ExecutionLedger): Promise<ExecutionEntry> {
	const entry = await ledger.read(ADMISSION);
	if (entry === undefined) throw new Error("the admitted execution disappeared");
	return entry;
}
