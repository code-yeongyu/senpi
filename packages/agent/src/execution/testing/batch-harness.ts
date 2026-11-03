import type { DurableStore, StoreValue, StoreWrite } from "../../durable/store.ts";
import { createAdmissionLine } from "../../durable/store-admission.ts";
import { type BatchCoordinator, createBatchCoordinator } from "../coordinator.ts";
import type { BatchConsent, BatchExecutor, BatchPlan, CallOutcome } from "../coordinator-types.ts";
import type { BatchCaseAdapters, PausePoint } from "./batch-executor.ts";

const ADMITTED_AT = 100;
const NOW = ADMITTED_AT + 1;

/** A coordinator write named by its step and call: `manifest`, `prepare:a`, `decision`, `release:a`, `outcome:a`. */
export type BrainKill = { readonly label: string; readonly at: "before" | "after" };

export class BrainKilledError extends Error {
	constructor(label: string) {
		super(`brain killed around ${label}`);
		this.name = "BrainKilledError";
	}
}

const isObject = (value: StoreValue | undefined): value is { readonly [key: string]: StoreValue } =>
	value !== null && typeof value === "object" && !Array.isArray(value);

function labelOf(writes: readonly StoreWrite[]): string | undefined {
	for (const write of writes) {
		if (write.op !== "append" || write.kind !== "execution.batch") continue;
		const data = write.data;
		if (!isObject(data)) return undefined;
		return typeof data.executionId === "string" ? `${String(data.step)}:${data.executionId}` : String(data.step);
	}
	return undefined;
}

function withCommit(store: DurableStore, commit: DurableStore["commit"]): DurableStore {
	return {
		readEpoch: () => store.readEpoch(),
		readHead: () => store.readHead(),
		claim: (expected, next) => store.claim(expected, next),
		commit,
		mintId: () => store.mintId(),
		scanRecords: (query) => store.scanRecords(query),
		getDocument: (key) => store.getDocument(key),
		scanDocuments: (prefix) => store.scanDocuments(prefix),
		exportSnapshot: () => store.exportSnapshot(),
		importSnapshot: (epoch, snapshot) => store.importSnapshot(epoch, snapshot),
	};
}

/**
 * The brain's store: `onDurable` sees the label of every durable write; with `kill`, the brain dies before that write
 * (nothing of it durable) or after it is durable, and never writes again.
 */
function brainStore(store: DurableStore, onDurable: (label: string) => void, kill?: BrainKill): DurableStore {
	let dead = false;
	return withCommit(store, async (epoch, writes, adopt) => {
		const label = labelOf(writes) ?? "";
		if (dead) throw new BrainKilledError(label);
		const hit = kill !== undefined && label === kill.label;
		if (hit && kill.at === "before") {
			dead = true;
			throw new BrainKilledError(label);
		}
		const result = await store.commit(epoch, writes, adopt);
		onDurable(label);
		if (hit) {
			dead = true;
			throw new BrainKilledError(label);
		}
		return result;
	});
}

function deadAfter(store: DurableStore, killed: AbortSignal): DurableStore {
	return withCommit(store, (epoch, writes, adopt) => {
		if (killed.aborted) return Promise.reject(new Error("a killed executor cannot write"));
		return store.commit(epoch, writes, adopt);
	});
}

export type CallSpec = readonly [executionId: string, executor: string, name?: string, sequential?: "sequential"];

export function batchPlan(batchId: string, calls: readonly CallSpec[]): BatchPlan {
	return {
		batchId,
		scope: "scope",
		workspace: "workspace",
		generation: 1,
		admittedAt: ADMITTED_AT,
		leaseUntil: ADMITTED_AT + 60_000,
		calls: calls.map(([executionId, executor, name = "read", sequential]) => ({
			executionId,
			executor,
			name,
			args: { executionId },
			sequential: sequential === "sequential",
		})),
	};
}

export const resultOf = (executionId: string, name = "read"): CallOutcome => ({
	kind: "result",
	value: { executionId, name } satisfies StoreValue,
});

export type BatchHarness = Awaited<ReturnType<typeof batchHarness>>;

/** Two executors (`e1`, `e2`) and one brain, each on its own durable medium, with pausable steps and kill controls. */
export async function batchHarness(adapters: BatchCaseAdapters) {
	const trace: string[] = [];
	const gates = new Map<string, { reached: PromiseWithResolvers<void>; open?: PromiseWithResolvers<void> }>();
	const gate = (key: string) => {
		let found = gates.get(key);
		if (found === undefined) {
			found = { reached: Promise.withResolvers<void>() };
			gates.set(key, found);
		}
		return found;
	};
	const pause = async (executionId: string, point: PausePoint): Promise<void> => {
		const found = gate(`${executionId}/${point}`);
		found.reached.resolve();
		if (found.open !== undefined) await found.open.promise;
	};

	const claimed = async (): Promise<string> => {
		const medium = await adapters.store.createMedium();
		await (await adapters.store.open(medium)).claim(0, 1);
		return medium;
	};
	let clock = NOW;
	const executors = new Map<string, { medium: string; killed: AbortController; endpoint: BatchExecutor }>();
	const start = async (id: string, medium: string): Promise<void> => {
		const killed = new AbortController();
		const store = deadAfter(await adapters.store.open(medium), killed.signal);
		const endpoint = await adapters.executor.open({
			id,
			store,
			epoch: 1,
			now: () => clock,
			trace,
			pause,
			killed: killed.signal,
		});
		executors.set(id, { medium, killed, endpoint });
	};
	const current = (id: string): BatchExecutor => {
		const found = executors.get(id);
		if (found === undefined) throw new Error(`no executor ${id}`);
		return found.endpoint;
	};
	const proxy = (id: string): BatchExecutor => ({
		prepare: (request) => current(id).prepare(request),
		release: (ref) => current(id).release(ref),
		abort: (ref) => current(id).abort(ref),
		consent: (ref, frozenDigest) => {
			const endpoint = current(id);
			if (endpoint.consent === undefined) throw new Error(`executor ${id} takes no consent`);
			return endpoint.consent(ref, frozenDigest);
		},
	});
	const kill = (id: string): string => {
		const found = executors.get(id);
		if (found === undefined) throw new Error(`no executor ${id}`);
		found.killed.abort();
		return found.medium;
	};
	for (const id of ["e1", "e2"]) await start(id, await claimed());
	const brainMedium = await claimed();
	const brainWrites: string[] = [];
	const writeWaiters = new Map<string, PromiseWithResolvers<readonly string[]>>();
	const onDurable = (label: string): void => {
		brainWrites.push(label);
		writeWaiters.get(label)?.resolve([...brainWrites]);
	};

	return {
		trace,
		count: (event: string): number => trace.filter((entry) => entry === event).length,
		/** Resolves with every durable brain write so far, at the moment the brain's `label` write becomes durable. */
		written: (label: string): Promise<readonly string[]> => {
			const waiter = Promise.withResolvers<readonly string[]>();
			writeWaiters.set(label, waiter);
			return waiter.promise;
		},
		/** Hold `executionId` at `point`: `reached` resolves when the step gets there, `open()` lets it continue. */
		hold: (executionId: string, point: PausePoint) => {
			const found = gate(`${executionId}/${point}`);
			const open = Promise.withResolvers<void>();
			found.open = open;
			return { reached: found.reached.promise, open: () => open.resolve() };
		},
		/**
		 * A fresh brain process over the brain's durable medium, optionally dying around one of its writes. Two issuers
		 * on one harness are two sessions' brains sharing the executors.
		 */
		brain: async (dieAt?: BrainKill, issuer = "brain", consent?: BatchConsent): Promise<BatchCoordinator> => {
			const opened = await adapters.store.open(brainMedium);
			return createBatchCoordinator({
				...(consent === undefined ? {} : { consent }),
				issuer,
				store: brainStore(opened, onDurable, dieAt),
				epoch: 1,
				admission: createAdmissionLine(),
				executor: proxy,
			});
		},
		/** Moves every executor's clock: a lease that ends before the new time is expired on the next ledger event. */
		advance: (ms: number): void => {
			clock += ms;
		},
		/** The executor proxy for `id`, as the brain reaches it (a late approval goes through it). */
		executor: proxy,
		/** Kill the executor process and start a new one on the same durable medium. */
		restartExecutor: async (id: string): Promise<void> => start(id, kill(id)),
		/** Kill the executor and start it on a new, empty medium: every execution it held is lost. */
		loseExecutor: async (id: string): Promise<void> => {
			kill(id);
			await start(id, await claimed());
		},
		ledgerState: async (id: string, executionId: string): Promise<string | undefined> => {
			const store = await adapters.store.open(executors.get(id)?.medium ?? "");
			const row = await store.getDocument(`execution.ledger:${JSON.stringify(["brain", executionId])}`);
			if (!isObject(row) || !isObject(row.progress)) return undefined;
			return String(row.progress.state);
		},
	};
}

export async function expectRejects(operation: Promise<unknown>, type: new (...args: never[]) => Error, what: string) {
	try {
		await operation;
	} catch (error) {
		if (error instanceof type) return;
		throw new Error(`${what}: expected ${type.name}, got ${String(error)}`);
	}
	throw new Error(`${what}: expected ${type.name}, but it resolved`);
}
