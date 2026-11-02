import type { DurableStore, StoreValue } from "../../durable/store.ts";
import type { StoreCaseAdapters } from "../../durable/testing/store-harness.ts";
import { createAdmissionLine } from "../../durable/store-admission.ts";
import type { BatchExecutor, ExecutionRef, PrepareReply, PrepareRequest, SettleReply } from "../coordinator-types.ts";
import { createExecutionLedger } from "../ledger.ts";
import type { ExecutionEntry, ExecutionEvent, ExecutionKey, LedgerReply } from "../ledger-types.ts";

/** Where a test can hold an execution: inside the `tool_call` chain, between release and dispatch, inside the body. */
export type PausePoint = "hook" | "dispatch" | "body";

/** What the scripted `tool_call` chain decides for a tool name; unknown names are allowed. */
const BATCH_TOOLS: Readonly<Record<string, "block" | "batch_abort">> = { deny: "block", stop: "batch_abort" };

export interface ExecutorOpenOptions {
	readonly id: string;
	/** The executor's own durable store, already claimed at `epoch`. */
	readonly store: DurableStore;
	readonly epoch: number;
	readonly now: () => number;
	/** Survives restarts: `shim:<id>`, `hook:<id>`, `body:<id>`, `done:<id>`, each appended when the step runs. */
	readonly trace: string[];
	readonly pause: (executionId: string, point: PausePoint) => Promise<void>;
	/** Aborted when the executor process is killed; a killed executor never writes or answers again. */
	readonly killed: AbortSignal;
}

/** The `executor` adapter: opens an executor endpoint over a store, recovering its durable executions first. */
export interface BatchExecutorConformanceAdapter {
	open(options: ExecutorOpenOptions): Promise<BatchExecutor>;
}

export type BatchCaseAdapters = StoreCaseAdapters & { readonly executor: BatchExecutorConformanceAdapter };

export class ExecutorKilledError extends Error {
	constructor(id: string) {
		super(`executor ${id} was killed`);
		this.name = "ExecutorKilledError";
	}
}

const markerKey = ({ issuer, commandId }: ExecutionKey): string =>
	`batch.executor.marker:${JSON.stringify([issuer, commandId])}`;

function expectEntry(reply: LedgerReply, what: string): ExecutionEntry {
	if (reply.status === "applied" || reply.status === "replayed") return reply.entry;
	throw new Error(`${what}: unexpected ledger reply ${JSON.stringify(reply)}`);
}

/**
 * A reference executor over the execution ledger: preparation runs a scripted shim and `tool_call` chain once, the
 * body runs once from the frozen call, and every answer is read back from durable state, so a re-sent message never
 * reruns a step.
 */
export const referenceBatchExecutor: BatchExecutorConformanceAdapter = {
	open: async (options) => {
		const { id, store, epoch, now, trace, pause, killed } = options;
		const ledger = createExecutionLedger({ store, epoch, admission: createAdmissionLine() });
		await ledger.recover(now());
		const death = new Promise<never>((_, reject) =>
			killed.addEventListener("abort", () => reject(new ExecutorKilledError(id)), { once: true }),
		);
		death.catch(() => {});
		const alive = (): void => {
			if (killed.aborted) throw new ExecutorKilledError(id);
		};
		const hold = async (executionId: string, point: PausePoint): Promise<void> => {
			await Promise.race([pause(executionId, point), death]);
			alive();
		};
		const keyOf = (ref: ExecutionRef): ExecutionKey => ({ issuer: ref.issuer, commandId: ref.executionId });
		const apply = (ref: ExecutionRef, event: ExecutionEvent, actor: string) =>
			ledger.apply({ key: keyOf(ref), generation: ref.generation, actor: { id: actor }, now: now(), event });

		const stored = async (entry: ExecutionEntry): Promise<PrepareReply> => {
			const progress = entry.progress;
			if (progress.state === "settled") return { kind: "settled", outcome: progress.outcome };
			if (!("call" in progress)) throw new Error(`no stored prepare reply in state ${progress.state}`);
			const marker = await store.getDocument(markerKey(entry));
			if (marker === "block") return { kind: "blocked", result: `blocked: ${progress.call.name}` };
			if (marker === "batch_abort") return { kind: "batch_abort" };
			return { kind: "prepared", frozenDigest: progress.call.digest };
		};
		const settled = async (ref: ExecutionRef): Promise<SettleReply> => {
			const entry = await ledger.read(keyOf(ref));
			if (entry === undefined) return { kind: "unknown_execution" };
			if (entry.progress.state !== "settled")
				throw new Error(`execution ${ref.executionId} is ${entry.progress.state}`);
			return { kind: "settled", outcome: entry.progress.outcome };
		};

		const prepare = async (request: PrepareRequest): Promise<PrepareReply> => {
			const { issuer, executionId: commandId, generation, workspace, scope, requestDigest, call } = request;
			const { admittedAt, leaseUntil } = request;
			const admission = {
				issuer,
				commandId,
				executor: id,
				workspace,
				scope,
				generation,
				requestDigest,
				admittedAt,
				leaseUntil,
			};
			const entry = expectEntry(await ledger.admit({ ...admission, reconcilable: false }), "admit");
			if (entry.progress.state !== "admitted") return stored(entry);
			expectEntry(await apply(request, { kind: "prepare" }, id), "prepare");
			expectEntry(await apply(request, { kind: "effect" }, id), "effect");
			trace.push(`shim:${commandId}`);
			trace.push(`hook:${commandId}`);
			await hold(commandId, "hook");
			const decision = BATCH_TOOLS[call.name];
			if (decision !== undefined)
				await store.commit(epoch, [{ op: "put", key: markerKey(entry), data: decision }], () => {});
			const frozen = { ...call, digest: `${requestDigest}:frozen` };
			const freeze: ExecutionEvent = { kind: "freeze", call: frozen, awaitingConsent: false };
			return stored(expectEntry(await apply(request, freeze, id), "freeze"));
		};

		const release = async (ref: ExecutionRef): Promise<SettleReply> => {
			const entry = await ledger.read(keyOf(ref));
			if (entry === undefined) return { kind: "unknown_execution" };
			if (entry.progress.state === "settled") return settled(ref);
			expectEntry(await apply(ref, { kind: "release" }, ref.issuer), "release");
			await hold(ref.executionId, "dispatch");
			const dispatched = expectEntry(await apply(ref, { kind: "dispatch" }, id), "dispatch");
			if (dispatched.progress.state === "dispatched") {
				trace.push(`body:${ref.executionId}`);
				await hold(ref.executionId, "body");
				const value: StoreValue = { executionId: ref.executionId, name: dispatched.progress.call.name };
				trace.push(`done:${ref.executionId}`);
				expectEntry(await apply(ref, { kind: "result", value }, id), "result");
			}
			return settled(ref);
		};

		const abort = async (ref: ExecutionRef): Promise<SettleReply> => {
			if ((await ledger.read(keyOf(ref))) === undefined) return { kind: "unknown_execution" };
			const reply = await apply(ref, { kind: "abort" }, ref.issuer);
			if (reply.status === "refused" && reply.reason !== "terminal")
				throw new Error(`abort refused: ${reply.reason}`);
			return settled(ref);
		};

		const once = <A extends ExecutionRef, R>(run: (input: A) => Promise<R>) => {
			const inflight = new Map<string, Promise<R>>();
			return (input: A): Promise<R> => {
				alive();
				const key = JSON.stringify([input.issuer, input.executionId]);
				const running = inflight.get(key);
				if (running !== undefined) return running;
				const started = run(input).finally(() => inflight.delete(key));
				inflight.set(key, started);
				return started;
			};
		};
		return { prepare: once(prepare), release: once(release), abort: once(abort) };
	},
};
