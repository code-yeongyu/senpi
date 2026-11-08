/**
 * Store, host, wait-condition and clock doubles for the device-route tests (CK9): a memory DurableStore behind one
 * admission line with write-point cuts for KILL cases, and doubles that record what the egress did so a case can fail.
 */
import {
	createAdmissionLine,
	createMemoryStoreMedium,
	type EgressHostHooks,
	type EgressWait,
	openMemoryStore,
	type StepRef,
	type WaitCondition,
} from "@earendil-works/pi-agent-core";
import type { DurableStore, StoreWritePoint } from "@earendil-works/pi-agent-core/conformance";
import { createEgressLedger, type EgressLedger } from "../../src/core/egress/ledger.ts";

export const SESSION = "session-1";

export interface StoreFixture {
	readonly medium: ReturnType<typeof createMemoryStoreMedium>;
	/** Opens the medium; with `cut`, the `nth` commit (1-based, counted on this open) throws at `at`. */
	open(cut?: { readonly nth: number; readonly at: "before" | "durable" }): Promise<DurableStore>;
}

export async function storeFixture(): Promise<StoreFixture> {
	const medium = createMemoryStoreMedium();
	const first = openMemoryStore(medium);
	await first.claim(0, 1);
	return {
		medium,
		async open(cut) {
			let commits = 0;
			return openMemoryStore(medium, {
				onWritePoint: (point: StoreWritePoint) => {
					if (!cut || point.op !== "commit") return;
					if (point.at === "before") commits += 1;
					if (commits === cut.nth && point.at === cut.at) throw new Error(`KILL commit ${cut.nth} ${cut.at}`);
				},
			});
		},
	};
}

export interface CommitWatch {
	/** Resolves once `count` ledger mutations of this rig are durable. */
	reached(count: number): Promise<void>;
}

export function ledgerOn(store: DurableStore, watch?: { notify(): void }): EgressLedger {
	const admission = createAdmissionLine();
	return createEgressLedger({
		store,
		mutate: (build) =>
			admission.admit(async () => {
				const writes = await build();
				await store.commit(1, writes, () => {});
				watch?.notify();
			}),
	});
}

export function commitWatch(): CommitWatch & { notify(): void } {
	let count = 0;
	const waiters = new Set<{ readonly count: number; readonly wake: () => void }>();
	return {
		reached(target) {
			if (count >= target) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.add({ count: target, wake: resolve });
			return promise;
		},
		notify() {
			count += 1;
			for (const waiter of [...waiters]) {
				if (waiter.count > count) continue;
				waiters.delete(waiter);
				waiter.wake();
			}
		},
	};
}

export interface HostDouble extends EgressHostHooks {
	readonly waits: EgressWait[];
	readonly waitEnds: string[];
	readonly history: Set<string>;
}

export function hostDouble(step: Partial<StepRef> = {}): HostDouble {
	const current: StepRef = {
		kind: "step",
		sessionId: SESSION,
		stepId: "step-1",
		attempt: 1,
		fence: { epoch: 1, admissionSeq: 1, generation: 1 },
		...step,
	};
	const waits: EgressWait[] = [];
	const waitEnds: string[] = [];
	const history = new Set<string>();
	return {
		waits,
		waitEnds,
		history,
		currentStep: () => current,
		admitAux: () => Promise.reject(new Error("aux calls belong to the composite egress (CK25)")),
		onWait: async (wait) => {
			waits.push(wait);
		},
		onWaitEnd: async (callId) => {
			waitEnds.push(callId);
		},
		historyHasStep: async (stepId) => history.has(stepId),
	};
}

export interface ConditionsDouble {
	readonly seen: (readonly WaitCondition[])[];
	until(waitFor: readonly WaitCondition[], signal: AbortSignal): Promise<void>;
	/** Resolves when the egress next starts waiting on a condition. */
	nextWait(): Promise<readonly WaitCondition[]>;
	release(): void;
}

export function conditionsDouble(): ConditionsDouble {
	const seen: (readonly WaitCondition[])[] = [];
	let pending: Array<() => void> = [];
	let watcher: ((waitFor: readonly WaitCondition[]) => void) | undefined;
	return {
		seen,
		until(waitFor, signal) {
			seen.push(waitFor);
			watcher?.(waitFor);
			watcher = undefined;
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			pending.push(resolve);
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			return promise;
		},
		nextWait() {
			const { promise, resolve } = Promise.withResolvers<readonly WaitCondition[]>();
			watcher = resolve;
			return promise;
		},
		release() {
			const waiting = pending;
			pending = [];
			for (const resolve of waiting) resolve();
		},
	};
}

export interface ManualClock {
	now(): number;
	sleep(ms: number, signal: AbortSignal): Promise<void>;
	advance(ms: number): void;
	/** Resolves when the egress next starts a sleep (of exactly `ms`, when given). */
	nextSleep(ms?: number): Promise<number>;
}

export function manualClock(): ManualClock {
	let now = 0;
	const sleepers = new Set<{ readonly until: number; readonly wake: () => void }>();
	let watcher: { readonly ms: number | undefined; readonly wake: (ms: number) => void } | undefined;
	return {
		now: () => now,
		sleep(ms, signal) {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			const sleeper = { until: now + ms, wake: resolve };
			sleepers.add(sleeper);
			signal.addEventListener(
				"abort",
				() => {
					sleepers.delete(sleeper);
					reject(signal.reason);
				},
				{ once: true },
			);
			if (watcher && (watcher.ms === undefined || watcher.ms === ms)) {
				watcher.wake(ms);
				watcher = undefined;
			}
			return promise;
		},
		advance(ms) {
			now += ms;
			for (const sleeper of [...sleepers]) {
				if (sleeper.until > now) continue;
				sleepers.delete(sleeper);
				sleeper.wake();
			}
		},
		nextSleep(ms) {
			const { promise, resolve } = Promise.withResolvers<number>();
			watcher = { ms, wake: resolve };
			return promise;
		},
	};
}

export interface GatedStore {
	readonly store: DurableStore;
	/** Resolves when the gated commit is about to run; nothing of it is durable yet. */
	readonly reached: Promise<void>;
	release(): void;
}

/** `store` whose `nth` commit (1-based) waits for `release`, so a case can look at the stream while that write is pending. */
export function gatedStore(store: DurableStore, nth: number): GatedStore {
	const reached = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	let commits = 0;
	return {
		reached: reached.promise,
		release: () => gate.resolve(),
		store: {
			...store,
			commit: async (epoch, writes, adopt) => {
				commits += 1;
				if (commits === nth) {
					reached.resolve();
					await gate.promise;
				}
				return store.commit(epoch, writes, adopt);
			},
		},
	};
}
