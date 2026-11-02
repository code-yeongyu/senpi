import type { AdmissionLine } from "../durable/store-admission.ts";
import type { DurableStore, StoreWrite } from "../durable/store.ts";
import { decodeExecution } from "./ledger-codec.ts";
import { transitionExecution } from "./ledger-transition.ts";
import {
	applied,
	type ExecutionAdmission,
	type ExecutionCommand,
	type ExecutionEntry,
	type ExecutionKey,
	type LedgerReply,
	MAX_EXECUTION_LIFETIME_MS,
	refused,
	replayed,
} from "./ledger-types.ts";

const PREFIX = "execution.ledger:";
const keyOf = ({ issuer, commandId }: ExecutionKey): string => `${PREFIX}${JSON.stringify([issuer, commandId])}`;

export interface ExecutionLedger {
	admit(input: ExecutionAdmission): Promise<LedgerReply>;
	apply(command: ExecutionCommand): Promise<LedgerReply>;
	read(key: ExecutionKey): Promise<ExecutionEntry | undefined>;
	/** Called once on endpoint restart; also expires overdue leases and reconciliation deadlines. */
	recover(now: number): Promise<void>;
}

/** All ledgers sharing a writable store epoch must share its single admission line. */
export function createExecutionLedger(options: {
	readonly store: DurableStore;
	readonly epoch: number;
	readonly admission: AdmissionLine;
}): ExecutionLedger {
	const { store, epoch, admission } = options;
	const read = async (key: ExecutionKey): Promise<ExecutionEntry | undefined> => {
		const value = await store.getDocument(keyOf(key));
		return value === undefined ? undefined : decodeExecution(value);
	};
	const persist = async (entry: ExecutionEntry, event: string, audit = false): Promise<void> => {
		const writes: StoreWrite[] = [
			{
				op: "append",
				id: store.mintId(),
				kind: audit ? "execution.audit" : "execution.transition",
				data: {
					issuer: entry.issuer,
					commandId: entry.commandId,
					generation: entry.generation,
					event,
					state: entry.progress.state,
				},
			},
		];
		if (!audit) writes.push({ op: "put", key: keyOf(entry), data: entry });
		await store.commit(epoch, writes, () => {});
	};
	const apply = (command: ExecutionCommand): Promise<LedgerReply> =>
		admission.admit(async () => {
			const entry = await read(command.key);
			if (entry === undefined) return refused("not_found");
			const reply = transitionExecution(entry, command);
			if (reply.status === "applied") await persist(reply.entry, command.event.kind);
			else if (
				reply.status === "replayed" &&
				entry.progress.state === "settled" &&
				(command.event.kind === "result" || command.event.kind === "cancel")
			)
				await persist(entry, command.event.kind, true);
			return reply;
		});
	return {
		read,
		apply,
		admit: (input) =>
			admission.admit(async () => {
				const prior = await read(input);
				if (prior !== undefined) {
					const same =
						prior.executor === input.executor &&
						prior.workspace === input.workspace &&
						prior.scope === input.scope &&
						prior.generation === input.generation &&
						prior.requestDigest === input.requestDigest &&
						prior.admittedAt === input.admittedAt &&
						prior.initialLeaseUntil === input.leaseUntil &&
						prior.reconcilable === input.reconcilable;
					return same ? replayed(prior) : refused("identity_conflict");
				}
				if (
					![
						input.issuer,
						input.commandId,
						input.executor,
						input.workspace,
						input.scope,
						input.requestDigest,
					].every(Boolean) ||
					!Number.isSafeInteger(input.generation) ||
					input.generation < 1 ||
					!Number.isFinite(input.admittedAt) ||
					!Number.isFinite(input.leaseUntil) ||
					input.leaseUntil <= input.admittedAt ||
					input.leaseUntil > input.admittedAt + MAX_EXECUTION_LIFETIME_MS
				)
					return refused("invalid_admission");
				const entry: ExecutionEntry = {
					...input,
					initialLeaseUntil: input.leaseUntil,
					renewSeq: 0,
					effectPossible: false,
					bodyDispatched: false,
					progress: { state: "admitted" },
				};
				await persist(entry, "admit");
				return applied(entry);
			}),
		recover: async (now) => {
			for (const document of await store.scanDocuments(PREFIX)) {
				const entry = decodeExecution(document.data);
				await apply({
					key: entry,
					generation: entry.generation,
					actor: { id: entry.executor },
					now,
					event: { kind: "restart" },
				});
			}
		},
	};
}
