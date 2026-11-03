import type {
	BatchConsent,
	BatchExecutor,
	ConsentRecord,
	ExecutionRef,
	ManifestCall,
	PrepareReply,
} from "./coordinator-types.ts";

export interface ConsentStep {
	readonly consent: BatchConsent;
	readonly executor: BatchExecutor;
	readonly ref: ExecutionRef;
	readonly call: ManifestCall;
	readonly leaseUntil: number;
	readonly recorded: ConsentRecord | null;
	readonly record: (answer: ConsentRecord) => Promise<void>;
}

export async function gateRawCall(
	_step: ConsentStep,
): Promise<{ readonly blocked: PrepareReply } | { readonly authorizedDigest?: string }> {
	return {};
}

export async function resolveFrozenConsent(_step: ConsentStep, frozenDigest: string): Promise<PrepareReply> {
	return { kind: "prepared", frozenDigest };
}
