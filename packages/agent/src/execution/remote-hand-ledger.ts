import type { StoreValue } from "../durable/store.ts";
import type { ExecutionLedger, LedgerGuard } from "./ledger.ts";
import type { ExecutionEntry, ExecutionEvent, ExecutionKey, LedgerReply } from "./ledger-types.ts";
import type { RemoteHandMessage, RemoteInvoke, RemoteToolResult } from "./remote-protocol.ts";

export interface HandLedgerOptions {
	readonly ledger: ExecutionLedger;
	/** This hand's identity, the ledger's executor. */
	readonly executor: string;
	/** The authenticated session the calls come from, the ledger's issuer. */
	readonly issuer: string;
	readonly workspace: string;
	readonly now: () => number;
	/** How long an admitted call may live; the ledger caps it at 24 hours. */
	readonly leaseMs: number;
}

/** What an invoke may do: run now, be answered from the record (an outcome or a refusal), or wait on its own run. */
export type HandAdmission =
	| { readonly kind: "run" }
	| { readonly kind: "reply"; readonly message: RemoteHandMessage }
	| { readonly kind: "in_flight" };

export interface HandLedger {
	/**
	 * `admits` is the sender's epoch check (S35), run inside every step of the walk: once it fails, the walk stops, a
	 * record it already wrote is cancelled (the call never dispatches), and the invoke is refused `epoch_fenced`.
	 */
	admit(invoke: RemoteInvoke, admits?: () => boolean): Promise<HandAdmission>;
	settle(invoke: RemoteInvoke, result: RemoteToolResult): Promise<RemoteHandMessage>;
	ack(executionId: string): Promise<void>;
	/**
	 * Runs the ledger's restart recovery, then returns every outcome the session has not acknowledged, by lane. Only the
	 * first call recovers: a later link's executor on the same live hand gets nothing, and its calls keep running.
	 */
	recover(): Promise<Array<{ readonly lane: string; readonly message: RemoteHandMessage }>>;
}

const GENERATION = 1;

function outcomeOf(entry: ExecutionEntry): RemoteHandMessage | undefined {
	const executionId = entry.commandId;
	if (entry.progress.state === "acked") return { kind: "refused", executionId, reason: "result_expired" };
	if (entry.progress.state !== "settled") return undefined;
	const { outcome } = entry.progress;
	if (outcome.reason === "result") {
		const result: RemoteToolResult = JSON.parse(String(outcome.value));
		return { kind: "settled", executionId, result };
	}
	// A hand settles a call only with `result` (settle) or a recovery terminal. A `blocked` outcome is the brain's
	// prepared executor's (S09): a record holding one was not written by this hand, so it is refused, never reported as run.
	if (outcome.reason === "blocked") return { kind: "refused", executionId, reason: "foreign_outcome" };
	return {
		kind: "terminal",
		executionId,
		reason: outcome.reason,
		uncertain: outcome.uncertain,
		hooksRan: outcome.hooksRan,
	};
}

function asStoreValue(value: unknown): StoreValue {
	return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

/**
 * A hand's durable record of the calls it runs (brain/hand split, S27a), on the execution ledger. A call is admitted and
 * walked to `dispatched` BEFORE its handlers and tool run, so a hand that dies mid-call recovers it as `hand_restarted`
 * (uncertain) and never runs it again; a re-delivered invoke is answered from the record. Today's run is one unit
 * (handlers, then the tool), so a call is frozen with its raw name and arguments.
 */
export function createHandLedger(options: HandLedgerOptions): HandLedger {
	const { ledger, executor, issuer, workspace, now, leaseMs } = options;
	const keyOf = (executionId: string): ExecutionKey => ({ issuer, commandId: executionId });
	const apply = (
		executionId: string,
		event: ExecutionEvent,
		actor: string,
		guard?: LedgerGuard,
	): Promise<LedgerReply> =>
		ledger.apply({ key: keyOf(executionId), generation: GENERATION, actor: { id: actor }, now: now(), event }, guard);
	let recovered: Promise<unknown> | undefined;
	/** Calls this process admitted or runs; a duplicate invoke for one of them waits on that run. */
	const owned = new Set<string>();
	const replyFrom = (reply: LedgerReply, executionId: string): RemoteHandMessage => {
		if (reply.status === "refused") return { kind: "refused", executionId, reason: reply.reason };
		if (reply.status === "result_expired") return { kind: "refused", executionId, reason: "result_expired" };
		return outcomeOf(reply.entry) ?? { kind: "refused", executionId, reason: "not_settled" };
	};
	const admitNew = (invoke: RemoteInvoke, digest: string, guard?: LedgerGuard): Promise<LedgerReply> => {
		const admittedAt = now();
		return ledger.admit(
			{
				issuer,
				commandId: invoke.executionId,
				executor,
				workspace,
				scope: invoke.scope.id,
				generation: GENERATION,
				requestDigest: digest,
				admittedAt,
				leaseUntil: admittedAt + leaseMs,
				reconcilable: false,
			},
			guard,
		);
	};
	/** A fenced walk: the record it wrote (if any) is cancelled so it never dispatches, and the invoke is refused. */
	const fenced = async (executionId: string): Promise<HandAdmission> => {
		if ((await ledger.read(keyOf(executionId))) !== undefined) await apply(executionId, { kind: "cancel" }, issuer);
		return { kind: "reply", message: { kind: "refused", executionId, reason: "epoch_fenced" } };
	};
	/**
	 * Walks a call to `dispatched` from whatever its record holds: a new call from admission, a `prepared` or
	 * `released` call that survived a restart from there. It runs only when THIS walk's `dispatch` applied. A record
	 * that holds another request under this execution ID (other name, arguments or scope) is refused
	 * `identity_conflict`, as the ledger refuses such an admission: a resumed call runs only what was frozen.
	 */
	const advance = async (invoke: RemoteInvoke, guard: LedgerGuard | undefined): Promise<HandAdmission> => {
		const { executionId } = invoke;
		const isFenced = (reply: LedgerReply): boolean => reply.status === "refused" && reply.reason === "epoch_fenced";
		const args = asStoreValue(invoke.arguments);
		const frozen = { name: invoke.name, args, digest: JSON.stringify([invoke.name, args]) };
		const prior = await ledger.read(keyOf(executionId));
		if (prior !== undefined && (prior.requestDigest !== frozen.digest || prior.scope !== invoke.scope.id))
			return { kind: "reply", message: { kind: "refused", executionId, reason: "identity_conflict" } };
		const settled = prior === undefined ? undefined : outcomeOf(prior);
		if (settled !== undefined) return { kind: "reply", message: settled };
		const fromStart: Array<() => Promise<LedgerReply>> = [
			() => admitNew(invoke, frozen.digest, guard),
			() => apply(executionId, { kind: "prepare" }, executor, guard),
			() => apply(executionId, { kind: "effect" }, executor, guard),
			() => apply(executionId, { kind: "freeze", call: frozen, awaitingConsent: false }, executor, guard),
		];
		const state = prior?.progress.state;
		const steps = state === undefined ? fromStart : state === "prepared" || state === "released" ? [] : undefined;
		if (steps === undefined) return { kind: "in_flight" };
		for (const step of [...steps, () => apply(executionId, { kind: "release" }, issuer, guard)]) {
			const reply = await step();
			if (isFenced(reply)) return fenced(executionId);
			if (reply.status === "replayed" && reply.entry.progress.state !== "settled") continue;
			if (reply.status !== "applied" || reply.entry.progress.state === "settled")
				return { kind: "reply", message: replyFrom(reply, executionId) };
		}
		const dispatched = await apply(executionId, { kind: "dispatch" }, executor, guard);
		if (isFenced(dispatched)) return fenced(executionId);
		if (dispatched.status === "applied" && dispatched.entry.progress.state === "dispatched") return { kind: "run" };
		if (dispatched.status === "replayed" && dispatched.entry.progress.state !== "settled")
			return { kind: "in_flight" };
		return { kind: "reply", message: replyFrom(dispatched, executionId) };
	};
	return {
		async admit(invoke, admits) {
			const { executionId } = invoke;
			if (owned.has(executionId)) return { kind: "in_flight" };
			owned.add(executionId);
			const guard: LedgerGuard | undefined =
				admits === undefined ? undefined : () => (admits() ? undefined : "epoch_fenced");
			const admission = await advance(invoke, guard).catch((error: unknown) => {
				owned.delete(executionId);
				throw error;
			});
			if (admission.kind !== "run") owned.delete(executionId);
			return admission;
		},
		async settle(invoke, result) {
			try {
				const reply = await apply(invoke.executionId, { kind: "result", value: JSON.stringify(result) }, executor);
				return replyFrom(reply, invoke.executionId);
			} finally {
				owned.delete(invoke.executionId);
			}
		},
		async ack(executionId) {
			await apply(executionId, { kind: "ack" }, issuer);
		},
		async recover() {
			if (recovered !== undefined) return recovered.then(() => []);
			recovered = ledger.recover(now());
			await recovered;
			return (await ledger.scan()).flatMap((entry) => {
				const message = entry.progress.state === "settled" ? outcomeOf(entry) : undefined;
				return message === undefined ? [] : [{ lane: entry.scope, message }];
			});
		},
	};
}
