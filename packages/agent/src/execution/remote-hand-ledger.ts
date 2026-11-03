import type { StoreValue } from "../durable/store.ts";
import type { ExecutionLedger } from "./ledger.ts";
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
	admit(invoke: RemoteInvoke): Promise<HandAdmission>;
	settle(invoke: RemoteInvoke, result: RemoteToolResult): Promise<RemoteHandMessage>;
	ack(executionId: string): Promise<void>;
	/** Runs the ledger's restart recovery, then returns every outcome the session has not acknowledged, by lane. */
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
	const apply = (executionId: string, event: ExecutionEvent, actor: string): Promise<LedgerReply> =>
		ledger.apply({ key: keyOf(executionId), generation: GENERATION, actor: { id: actor }, now: now(), event });
	/** Calls this process admitted or runs; a duplicate invoke for one of them waits on that run. */
	const owned = new Set<string>();
	const replyFrom = (reply: LedgerReply, executionId: string): RemoteHandMessage => {
		if (reply.status === "refused") return { kind: "refused", executionId, reason: reply.reason };
		if (reply.status === "result_expired") return { kind: "refused", executionId, reason: "result_expired" };
		return outcomeOf(reply.entry) ?? { kind: "refused", executionId, reason: "not_settled" };
	};
	const admitNew = (invoke: RemoteInvoke, digest: string): Promise<LedgerReply> => {
		const admittedAt = now();
		return ledger.admit({
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
		});
	};
	/**
	 * Walks a call to `dispatched` from whatever its record holds: a new call from admission, a `prepared` or
	 * `released` call that survived a restart from there. It runs only when THIS walk's `dispatch` applied. A record
	 * that holds another request under this execution ID (other name, arguments or scope) is refused
	 * `identity_conflict`, as the ledger refuses such an admission: a resumed call runs only what was frozen.
	 */
	const advance = async (invoke: RemoteInvoke): Promise<HandAdmission> => {
		const { executionId } = invoke;
		const args = asStoreValue(invoke.arguments);
		const frozen = { name: invoke.name, args, digest: JSON.stringify([invoke.name, args]) };
		const prior = await ledger.read(keyOf(executionId));
		if (prior !== undefined && (prior.requestDigest !== frozen.digest || prior.scope !== invoke.scope.id))
			return { kind: "reply", message: { kind: "refused", executionId, reason: "identity_conflict" } };
		const settled = prior === undefined ? undefined : outcomeOf(prior);
		if (settled !== undefined) return { kind: "reply", message: settled };
		const fromStart: Array<() => Promise<LedgerReply>> = [
			() => admitNew(invoke, frozen.digest),
			() => apply(executionId, { kind: "prepare" }, executor),
			() => apply(executionId, { kind: "effect" }, executor),
			() => apply(executionId, { kind: "freeze", call: frozen, awaitingConsent: false }, executor),
		];
		const state = prior?.progress.state;
		const steps = state === undefined ? fromStart : state === "prepared" || state === "released" ? [] : undefined;
		if (steps === undefined) return { kind: "in_flight" };
		for (const step of [...steps, () => apply(executionId, { kind: "release" }, issuer)]) {
			const reply = await step();
			if (reply.status === "replayed" && reply.entry.progress.state !== "settled") continue;
			if (reply.status !== "applied" || reply.entry.progress.state === "settled")
				return { kind: "reply", message: replyFrom(reply, executionId) };
		}
		const dispatched = await apply(executionId, { kind: "dispatch" }, executor);
		if (dispatched.status === "applied" && dispatched.entry.progress.state === "dispatched") return { kind: "run" };
		if (dispatched.status === "replayed" && dispatched.entry.progress.state !== "settled")
			return { kind: "in_flight" };
		return { kind: "reply", message: replyFrom(dispatched, executionId) };
	};
	return {
		async admit(invoke) {
			const { executionId } = invoke;
			if (owned.has(executionId)) return { kind: "in_flight" };
			owned.add(executionId);
			const admission = await advance(invoke).catch((error: unknown) => {
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
			await ledger.recover(now());
			return (await ledger.scan()).flatMap((entry) => {
				const message = entry.progress.state === "settled" ? outcomeOf(entry) : undefined;
				return message === undefined ? [] : [{ lane: entry.scope, message }];
			});
		},
	};
}
