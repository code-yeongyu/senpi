import type { StoreValue } from "../durable/store.ts";
import type {
	BatchConsent,
	BatchExecutor,
	ConsentAnswer,
	ConsentRecord,
	ExecutionRef,
	ManifestCall,
	PrepareReply,
} from "./coordinator-types.ts";
import type { ExecutionOutcome } from "./ledger-types.ts";

/** What a call needs from the consent port, and how an answer is recorded before the step it decides. */
export interface ConsentStep {
	readonly consent: BatchConsent;
	readonly executor: BatchExecutor;
	readonly ref: ExecutionRef;
	readonly call: ManifestCall;
	readonly leaseUntil: number;
	/** The call's answered consent, if one is durable. */
	readonly recorded: ConsentRecord | null;
	readonly record: (answer: ConsentRecord) => Promise<void>;
}

const denied = (gate: ConsentRecord["gate"], answer: ConsentAnswer): PrepareReply => ({
	kind: "blocked",
	result: { reason: "consent_denied", gate, answer } satisfies StoreValue,
});

/** The executor no longer knows a call it prepared (design 5.6.2 "a lost prepared execution"): uncertain, never rerun. */
const lost: ExecutionOutcome = { reason: "uncertain", hooksRan: true, uncertain: true };

async function answer(step: ConsentStep, gate: ConsentRecord["gate"], digest: string): Promise<ConsentAnswer> {
	const { recorded } = step;
	if (recorded !== null && recorded.gate === gate && recorded.digest === digest) return recorded.answer;
	const given = await step.consent.approve({
		...step.ref,
		gate,
		digest,
		name: step.call.name,
		leaseUntil: step.leaseUntil,
	});
	await step.record({ gate, digest, answer: given });
	return given;
}

/**
 * Gate A, before preparation: a raw call that needs consent is prepared only after an approval of its request digest,
 * which the executor then treats as authorized. A refusal ran nothing, so it is a blocked per-call result.
 */
export async function gateRawCall(
	step: ConsentStep,
): Promise<{ readonly blocked: PrepareReply } | { readonly authorizedDigest?: string }> {
	const { call } = step;
	if (!step.consent.needsConsent({ name: call.name, args: call.args })) return {};
	const given = await answer(step, "raw", call.requestDigest);
	return given === "approved" ? { authorizedDigest: call.requestDigest } : { blocked: denied("raw", given) };
}

/**
 * Gate B, after preparation: the approval binds the frozen digest and the executor releases without rerunning hooks.
 * A denial is a blocked per-call result; an expiry (or an approval the lease already outran) settles the call
 * `lease_expired`, which ABORTs the batch's unreleased calls. Nothing is ever prepared again: no automatic successor.
 */
export async function resolveFrozenConsent(step: ConsentStep, frozenDigest: string): Promise<PrepareReply> {
	const given = await answer(step, "frozen", frozenDigest);
	if (given === "denied") {
		await step.executor.abort(step.ref);
		return denied("frozen", given);
	}
	const reply =
		given === "approved"
			? await consentOn(step.executor, step.ref, frozenDigest)
			: await step.executor.abort(step.ref);
	if (reply.kind === "prepared") return { kind: "prepared", frozenDigest };
	if (reply.kind === "unknown_execution") return { kind: "settled", outcome: lost };
	return { kind: "settled", outcome: reply.outcome };
}

function consentOn(executor: BatchExecutor, ref: ExecutionRef, frozenDigest: string) {
	if (executor.consent === undefined)
		throw new Error(`executor answered prepared_awaiting_consent for ${ref.executionId} but cannot take consent`);
	return executor.consent(ref, frozenDigest);
}
