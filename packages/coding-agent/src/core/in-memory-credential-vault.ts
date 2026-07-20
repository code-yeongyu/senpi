import type {
	ConsumeSelectionLeaseRequest,
	CredentialRecord,
	CredentialSelector,
	CredentialVault,
	MetadataSnapshot,
	PendingSelectionLease,
	SelectionLease,
	SelectionLeaseRequest,
	SerializedCredentialVault,
	UsageReport,
	VaultDiagnostic,
} from "./auth-multi-account.ts";
import { PooledCredentialSelector } from "./credential-selection.ts";

type StoredLease = {
	readonly authentication: string;
	readonly credential: CredentialRecord;
	readonly leaseId: string;
	readonly selector: CredentialSelector;
	readonly sessionId?: string;
};

export class InMemoryCredentialVault implements CredentialVault {
	private records: CredentialRecord[];
	private readonly leases = new Map<string, StoredLease>();
	private leaseSequence = 0;
	private readonly selector: PooledCredentialSelector;
	private readonly diagnostic?: (entry: VaultDiagnostic) => void;

	private constructor(
		records: readonly CredentialRecord[],
		diagnostic?: (entry: VaultDiagnostic) => void,
		now?: () => number,
	) {
		this.records = Array.from(structuredClone(records));
		this.diagnostic = diagnostic;
		this.selector = new PooledCredentialSelector(now);
	}

	static fromRecords(
		records: readonly CredentialRecord[],
		diagnostic?: (entry: VaultDiagnostic) => void,
		now?: () => number,
	): InMemoryCredentialVault {
		return new InMemoryCredentialVault(records, diagnostic, now);
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
		return { credentials: this.records.map(toCredentialMetadata), generatedAt: new Date().toISOString() };
	}

	issueSelectionLease(request: SelectionLeaseRequest, authentication: string): PendingSelectionLease {
		const credential = this.selectCredential(request);
		this.leaseSequence += 1;
		const leaseId = `lease-${this.leaseSequence}`;
		this.leases.set(leaseId, {
			authentication,
			credential,
			leaseId,
			selector: structuredClone(request.selector),
			sessionId: request.sessionId,
		});
		return {
			credentialId: credential.credentialId,
			leaseId,
			pool: { ...credential.pool },
			selector: structuredClone(request.selector),
			sessionId: request.sessionId,
		};
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
			selector: structuredClone(stored.selector),
			sessionId: stored.sessionId,
			reportOutcome: (report) => {
				this.reportUsage({
					...report,
					credentialId: stored.credential.credentialId,
					pool: { ...stored.credential.pool },
				});
			},
		};
	}

	reportUsage(report: UsageReport): void {
		this.selector.reportOutcome(report);
	}

	runRefresh<T>(credentialId: string, refresh: () => Promise<T>): Promise<T> {
		return this.selector.runRefresh(credentialId, refresh);
	}

	private selectCredential(request: SelectionLeaseRequest): CredentialRecord {
		try {
			return this.selector.select(this.records, request);
		} catch (error) {
			this.diagnostic?.({ code: "selector_rejected" });
			throw error;
		}
	}
}

function toCredentialMetadata(record: CredentialRecord) {
	return {
		createdAt: record.createdAt,
		credentialId: record.credentialId,
		disabled: record.disabled === undefined ? undefined : { ...record.disabled },
		identityKey: record.identityKey,
		pool: { ...record.pool },
		updatedAt: record.updatedAt,
	};
}
