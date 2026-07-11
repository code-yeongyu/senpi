/**
 * Multi-account credential domain contracts.
 *
 * This module deliberately separates durable credential material from the
 * redacted metadata visible to broker clients. A SelectionLease is the sole
 * value that can carry selected API or access material to a trusted gateway.
 */

export { InMemoryCredentialVault } from "./in-memory-credential-vault.ts";

export type CredentialPool = {
	readonly provider: string;
	readonly type: CredentialMaterial["type"];
};

export type CredentialPoolKey = `${string}:${CredentialMaterial["type"]}`;

export type StableIdentityKey = string;

export type DisabledCredentialState = {
	readonly at: string;
	readonly cause: string;
};

export type ApiKeyCredentialMaterial = {
	readonly apiKey: string;
	readonly type: "api_key";
};

export type OAuthCredentialMaterial = {
	readonly accessToken: string;
	readonly expiresAt: number;
	readonly refreshToken: string;
	readonly type: "oauth";
};

export type CredentialMaterial = ApiKeyCredentialMaterial | OAuthCredentialMaterial;

export type CredentialRecord = {
	readonly createdAt: string;
	readonly credentialId: string;
	readonly disabled?: DisabledCredentialState;
	readonly identityKey: StableIdentityKey;
	readonly material: CredentialMaterial;
	readonly pool: CredentialPool;
	readonly updatedAt: string;
};

export type CredentialMetadata = {
	readonly createdAt: string;
	readonly credentialId: string;
	readonly disabled?: DisabledCredentialState;
	readonly identityKey: StableIdentityKey;
	readonly pool: CredentialPool;
	readonly updatedAt: string;
};

export type MetadataSnapshot = {
	readonly credentials: readonly CredentialMetadata[];
	readonly generatedAt: string;
};

export type CredentialSelector =
	| { readonly kind: "automatic" }
	| { readonly credentialId: string; readonly kind: "credential" }
	| { readonly identityKey: StableIdentityKey; readonly kind: "identity" };

export type SelectionLeaseRequest = {
	readonly pool: CredentialPool;
	readonly selector: CredentialSelector;
	readonly sessionId?: string;
};

export type PendingSelectionLease = {
	readonly credentialId: string;
	readonly leaseId: string;
	readonly pool: CredentialPool;
	readonly selector: CredentialSelector;
	readonly sessionId?: string;
};

export type SelectionLease = PendingSelectionLease & {
	readonly material: CredentialMaterial;
	reportOutcome(report: Omit<UsageReport, "credentialId" | "pool">): void;
};

export type ConsumeSelectionLeaseRequest = {
	readonly authentication: string;
	readonly leaseId: string;
};

export type UsageReport = {
	readonly credentialId: string;
	readonly observedAt: string;
	readonly pool: CredentialPool;
	readonly remainingFraction?: number;
	readonly status: "success" | "rate_limited" | "unauthorized" | "unavailable";
};

export type VaultDiagnostic = {
	readonly code: "lease_authentication_failed" | "lease_consumed" | "selector_rejected";
	readonly credentialId?: string;
	readonly leaseId?: string;
};

export interface CredentialVault {
	load(): readonly CredentialRecord[];
	save(records: readonly CredentialRecord[]): void;
	metadataSnapshot(): MetadataSnapshot;
	issueSelectionLease(request: SelectionLeaseRequest, authentication: string): PendingSelectionLease;
	consumeSelectionLease(request: ConsumeSelectionLeaseRequest): SelectionLease;
	reportUsage(report: UsageReport): void;
}

export type SerializedCredentialVault = {
	readonly credentials: readonly CredentialRecord[];
};

export function credentialPoolKey(pool: CredentialPool): CredentialPoolKey {
	return `${pool.provider}:${pool.type}`;
}
