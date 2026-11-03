import type { DurableStore } from "../durable/store.ts";
import type { AdmissionLine } from "../durable/store-admission.ts";
import { decodeBatchRecord } from "./coordinator-codec.ts";
import { abortCause, buildBatchManifest, finished, settledOutcome } from "./coordinator-plan.ts";
import type {
	BatchExecutor,
	BatchPlan,
	BatchRecord,
	BatchResult,
	CallOutcome,
	ExecutionRef,
	ManifestCall,
	SettleReply,
} from "./coordinator-types.ts";

const PREFIX = "execution.batch:";
const keyOf = (issuer: string, batchId: string): string => `${PREFIX}${JSON.stringify([issuer, batchId])}`;

export class BatchManifestConflictError extends Error {
	constructor(batchId: string) {
		super(`batch ${batchId} already has a different durable manifest`);
		this.name = "BatchManifestConflictError";
	}
}

export interface BatchCoordinatorOptions {
	readonly issuer: string;
	readonly store: DurableStore;
	readonly epoch: number;
	/** The single admission line of the store's writable epoch, shared with every other writer on it. */
	readonly admission: AdmissionLine;
	readonly executor: (id: string) => BatchExecutor;
}

export interface BatchCoordinator {
	/**
	 * Runs one batch to its final outcomes: manifest, prepare in source order, one decision, then release by
	 * dependencies or abort. A batch with a durable record resumes from it, so calling `run` again after a crash (or
	 * after an executor call failed) recovers instead of starting over.
	 */
	run(plan: BatchPlan): Promise<BatchResult>;
	read(batchId: string): Promise<BatchRecord | undefined>;
}

type Settlement = { readonly index: number } & (
	| { readonly ok: true; readonly reply: SettleReply }
	| { readonly ok: false; readonly error: unknown }
);

const replace = <T>(items: readonly T[], index: number, value: T): T[] =>
	items.map((item, at) => (at === index ? value : item));

export function createBatchCoordinator(options: BatchCoordinatorOptions): BatchCoordinator {
	const { issuer, store, epoch, admission, executor } = options;
	const read = async (batchId: string): Promise<BatchRecord | undefined> => {
		const value = await store.getDocument(keyOf(issuer, batchId));
		return value === undefined ? undefined : decodeBatchRecord(value);
	};

	return {
		read,
		run: async (plan) => {
			const manifest = await buildBatchManifest(issuer, plan);
			const key = keyOf(issuer, plan.batchId);
			let record = await read(plan.batchId);
			const persist = async (next: BatchRecord, step: string, call?: ManifestCall): Promise<void> => {
				const data = { batchId: plan.batchId, step, executionId: call?.executionId ?? null };
				await admission.admit(() =>
					store.commit(
						epoch,
						[
							{ op: "append", id: store.mintId(), kind: "execution.batch", data },
							{ op: "put", key, data: next },
						],
						() => {},
					),
				);
				record = next;
			};
			const current = (): BatchRecord => {
				if (record === undefined) throw new Error(`batch ${plan.batchId} has no durable record`);
				return record;
			};
			const ref = (call: ManifestCall): ExecutionRef => ({
				issuer,
				executionId: call.executionId,
				generation: manifest.generation,
			});
			const settle = async (call: ManifestCall, outcome: CallOutcome): Promise<void> =>
				persist(
					{ ...current(), outcomes: replace(current().outcomes, call.sourceIndex, outcome) },
					"outcome",
					call,
				);

			if (record === undefined) {
				const empty = manifest.calls.map(() => null);
				await persist(
					{
						manifest,
						prepares: empty,
						decision: null,
						released: manifest.calls.map(() => false),
						outcomes: empty,
					},
					"manifest",
				);
			} else if (record.manifest.manifestDigest !== manifest.manifestDigest) {
				throw new BatchManifestConflictError(plan.batchId);
			}

			if (current().decision === null) {
				for (const call of manifest.calls) {
					let reply = current().prepares[call.sourceIndex] ?? null;
					if (reply === null) {
						reply = await executor(call.executor).prepare({
							...ref(call),
							batchId: manifest.batchId,
							manifestDigest: manifest.manifestDigest,
							scope: manifest.scope,
							workspace: manifest.workspace,
							admittedAt: manifest.admittedAt,
							leaseUntil: manifest.leaseUntil,
							requestDigest: call.requestDigest,
							call: { name: call.name, args: call.args },
						});
						await persist(
							{ ...current(), prepares: replace(current().prepares, call.sourceIndex, reply) },
							"prepare",
							call,
						);
					}
					if (abortCause(reply) !== undefined) break;
				}
				const aborted = current().prepares.some((reply) => reply !== null && abortCause(reply) !== undefined);
				await persist({ ...current(), decision: aborted ? "ABORT" : "RELEASE" }, "decision");
			}

			const cause =
				current()
					.prepares.map((reply) => (reply === null ? undefined : abortCause(reply)))
					.find((found) => found !== undefined) ?? "batch_abort";
			for (const call of manifest.calls) {
				if (current().outcomes[call.sourceIndex] !== null) continue;
				const reply = current().prepares[call.sourceIndex] ?? null;
				if (reply?.kind === "settled") await settle(call, settledOutcome(reply));
				else if (reply?.kind === "blocked") {
					await executor(call.executor).abort(ref(call));
					await settle(call, { kind: "blocked", result: reply.result });
				} else if (current().decision === "ABORT") {
					if (reply !== null) await executor(call.executor).abort(ref(call));
					await settle(call, { kind: "not_run", cause });
				}
			}

			const inflight = new Map<number, Promise<Settlement>>();
			for (;;) {
				for (const call of manifest.calls) {
					const index = call.sourceIndex;
					if (current().outcomes[index] !== null || inflight.has(index)) continue;
					if (!current().released[index]) {
						const ready = call.dependsOn.every((dependency) =>
							finished(manifest.calls, current().outcomes, dependency),
						);
						if (!ready) continue;
						await persist({ ...current(), released: replace(current().released, index, true) }, "release", call);
					}
					inflight.set(
						index,
						executor(call.executor)
							.release(ref(call))
							.then(
								(reply): Settlement => ({ index, ok: true, reply }),
								(error: unknown): Settlement => ({ index, ok: false, error }),
							),
					);
				}
				if (inflight.size === 0) break;
				const settled = await Promise.race(inflight.values());
				inflight.delete(settled.index);
				if (!settled.ok) throw settled.error;
				const call = manifest.calls[settled.index];
				if (call !== undefined) await settle(call, settledOutcome(settled.reply));
			}

			const { decision, outcomes } = current();
			const final = outcomes.filter((outcome): outcome is CallOutcome => outcome !== null);
			if (decision === null || final.length !== outcomes.length)
				throw new Error(`batch ${plan.batchId} ended with an unsettled call`);
			return { decision, outcomes: final };
		},
	};
}
