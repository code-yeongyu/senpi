import type { HpkeWrap, ProviderId, SecretField } from "./sealed-format.ts";

export type { SecretField } from "./sealed-format.ts";

export interface SecretLease extends Disposable {
	/** Throws SecretNotLeased for a field outside this lease, or after dispose. */
	value(field: SecretField): string;
	readonly expiresAt?: number;
	/** Drops references and zeroes the byte buffers (custody design 3.4). */
	[Symbol.dispose](): void;
}

/** Audit only; asserted by the brain. */
export interface ReleaseScope {
	readonly sessionId: string;
	readonly callId: string;
	readonly purpose: "model-call" | "aux-call";
}

export interface CredentialSource {
	resolve(
		providerId: ProviderId,
		entryDigest: string,
		fields: readonly SecretField[],
		scope: ReleaseScope,
	): Promise<SecretLease>;
}

/** Registry-signed `{account, placementId, epoch, recipientPkHash, exp <= 60 s}`. */
export interface EpochLeaseToken {
	readonly token: string;
}

export interface ReleaseRequest {
	readonly accountId: string;
	readonly providerId: ProviderId;
	/** Must equal the head entry's. */
	readonly entryDigest: string;
	readonly fields: readonly SecretField[];
	readonly lease: EpochLeaseToken;
	readonly recipientPk: Uint8Array;
	readonly scope: ReleaseScope;
}

export interface ReleaseConfigRequest {
	readonly accountId: string;
	readonly objectHash: string;
	readonly lease: EpochLeaseToken;
	readonly recipientPk: Uint8Array;
	readonly scope: ReleaseScope;
}

export type ReleaseFailure =
	| "stale_snapshot"
	| "epoch_mismatch"
	| "owner_revoked"
	| "owner_withdrawn"
	| "unknown_field"
	| "unresolved_field"
	| "key_destroyed"
	| "wrap_missing"
	| "unavailable"
	| "denied";

export interface HeadRef {
	readonly version: number;
	readonly objectHash: string;
}

export type ReleaseResult =
	| { readonly ok: true; readonly items: readonly HpkeWrap[]; readonly head: HeadRef }
	| { readonly ok: false; readonly code: ReleaseFailure; readonly head?: HeadRef };

export interface Unsealer {
	release(req: ReleaseRequest): Promise<ReleaseResult>;
	/** One item: the ProviderConfigPlain sealed to recipientPk. K_cfg and K_proj are never released. */
	releaseConfig(req: ReleaseConfigRequest): Promise<ReleaseResult>;
}

export class SecretNotLeased extends Error {
	readonly field: SecretField;

	constructor(field: SecretField) {
		super(`secret not leased: ${field}`);
		this.name = "SecretNotLeased";
		this.field = field;
	}
}

export type CredentialWaitReason = ReleaseFailure | "config-churn";

/**
 * A sealed release that did not produce a value. It is never a plaintext fallback: the caller routes the step to a
 * device or waits. `retryable` marks the refusals that clear on their own (custody design 3.3 and the L844 rule).
 */
export class CredentialWait extends Error {
	readonly reason: CredentialWaitReason;
	readonly retryable: boolean;

	constructor(reason: CredentialWaitReason, retryable: boolean) {
		super(`sealed credential unavailable: ${reason}`);
		this.name = "CredentialWait";
		this.reason = reason;
		this.retryable = retryable;
	}
}
