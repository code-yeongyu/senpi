/**
 * Multi-account credential domain contracts.
 *
 * This module deliberately separates durable credential material from the
 * redacted metadata visible to broker clients. A SelectionLease is the sole
 * value that can carry selected API or access material to a trusted gateway.
 */

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
};

export type PendingSelectionLease = {
	readonly credentialId: string;
	readonly leaseId: string;
	readonly pool: CredentialPool;
};

export type SelectionLease = PendingSelectionLease & {
	readonly material: CredentialMaterial;
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

type StoredLease = {
	readonly authentication: string;
	readonly credential: CredentialRecord;
	readonly leaseId: string;
};

export type SerializedCredentialVault = {
	readonly credentials: readonly CredentialRecord[];
};

export function credentialPoolKey(pool: CredentialPool): CredentialPoolKey {
	return `${pool.provider}:${pool.type}`;
}

export class InMemoryCredentialVault implements CredentialVault {
	private records: CredentialRecord[];
	private readonly leases = new Map<string, StoredLease>();
	private readonly reports: UsageReport[] = [];
	private leaseSequence = 0;
	private readonly diagnostic?: (entry: VaultDiagnostic) => void;

	private constructor(records: readonly CredentialRecord[], diagnostic?: (entry: VaultDiagnostic) => void) {
		this.records = Array.from(structuredClone(records));
		this.diagnostic = diagnostic;
	}

	static fromRecords(
		records: readonly CredentialRecord[],
		diagnostic?: (entry: VaultDiagnostic) => void,
	): InMemoryCredentialVault {
		return new InMemoryCredentialVault(records, diagnostic);
	}

	static fromSerialized(serialized: SerializedCredentialVault): InMemoryCredentialVault {
		return new InMemoryCredentialVault(serialized.credentials);
	}

	load(): readonly CredentialRecord[] {
		return structuredClone(this.records);
	}

	save(records: readonly CredentialRecord[]): void {
		this.records = Array.from(structuredClone(records));
		this.leases.clear();
	}

	serialize(): SerializedCredentialVault {
		return { credentials: this.load() };
	}

	metadataSnapshot(): MetadataSnapshot {
		return {
			credentials: this.records.map(toCredentialMetadata),
			generatedAt: new Date().toISOString(),
		};
	}

	issueSelectionLease(request: SelectionLeaseRequest, authentication: string): PendingSelectionLease {
		const credential = this.selectCredential(request);
		this.leaseSequence += 1;
		const leaseId = `lease-${this.leaseSequence}`;
		this.leases.set(leaseId, { authentication, credential, leaseId });
		return { credentialId: credential.credentialId, leaseId, pool: { ...credential.pool } };
	}

	consumeSelectionLease(request: ConsumeSelectionLeaseRequest): SelectionLease {
		const stored = this.leases.get(request.leaseId);
		if (stored === undefined) {
			this.diagnostic?.({ code: "lease_consumed", leaseId: request.leaseId });
			throw new Error("Selection lease is no longer available");
		}
		if (stored.authentication !== request.authentication) {
			this.diagnostic?.({ code: "lease_authentication_failed", leaseId: request.leaseId });
			throw new Error("Selection lease authentication failed");
		}
		this.leases.delete(request.leaseId);
		return {
			credentialId: stored.credential.credentialId,
			leaseId: stored.leaseId,
			material: structuredClone(stored.credential.material),
			pool: { ...stored.credential.pool },
		};
	}

	reportUsage(report: UsageReport): void {
		this.reports.push({ ...report, pool: { ...report.pool } });
	}

	private selectCredential(request: SelectionLeaseRequest): CredentialRecord {
		const candidates = this.records.filter(
			(record) =>
				credentialPoolKey(record.pool) === credentialPoolKey(request.pool) && record.disabled === undefined,
		);
		const selected = candidates.find((record) => matchesSelector(record, request.selector));
		if (selected === undefined) {
			this.diagnostic?.({ code: "selector_rejected" });
			throw new Error("No credential matches selector");
		}
		return selected;
	}
}

function matchesSelector(record: CredentialRecord, selector: CredentialSelector): boolean {
	switch (selector.kind) {
		case "automatic":
			return true;
		case "credential":
			return record.credentialId === selector.credentialId;
		case "identity":
			return record.identityKey === selector.identityKey;
		default:
			return assertNever(selector);
	}
}

function toCredentialMetadata(record: CredentialRecord): CredentialMetadata {
	return {
		createdAt: record.createdAt,
		credentialId: record.credentialId,
		disabled: record.disabled === undefined ? undefined : { ...record.disabled },
		identityKey: record.identityKey,
		pool: { ...record.pool },
		updatedAt: record.updatedAt,
	};
}

function assertNever(value: never): never {
	throw new Error(`Unexpected credential contract variant: ${JSON.stringify(value)}`);
}
