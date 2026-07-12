// allow: SIZE_OK — SQLite vault transaction state and its protocol boundary share one atomic invariant.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
	AuthBrokerCapability,
	AuthBrokerWireRequest,
	AuthBrokerWireResponse,
} from "./auth-broker-wire-contract.ts";
import { AUTH_BROKER_PROTOCOL_VERSION, parseAuthBrokerWireRequest } from "./auth-broker-wire-contract.ts";
import type {
	ConsumeSelectionLeaseRequest,
	CredentialMaterial,
	CredentialMetadata,
	CredentialPool,
	CredentialRecord,
	CredentialSelector,
	CredentialVault,
	MetadataSnapshot,
	PendingSelectionLease,
	SelectionLease,
	SelectionLeaseRequest,
	UsageReport,
} from "./auth-multi-account.ts";
import { credentialPoolKey } from "./auth-multi-account.ts";

type BrokerClient = {
	readonly authentication: string;
	readonly capabilities: readonly AuthBrokerCapability[];
	readonly trustedGateway: boolean;
};
type RefreshCredential = (credential: CredentialRecord) => Promise<CredentialMaterial>;

const COOL_DOWN_MS = { rate_limited: 30_000, unavailable: 10_000, unauthorized: 300_000 } as const;

export class AuthBrokerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthBrokerError";
	}
}

export class SqliteCredentialVault implements CredentialVault {
	private readonly db: DatabaseSync;

	private constructor(path: string) {
		this.db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5_000 });
		this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
		this.migrate();
	}

	static open(path: string): SqliteCredentialVault {
		return new SqliteCredentialVault(path);
	}

	close(): void {
		this.db.close();
	}

	load(): readonly CredentialRecord[] {
		return this.db.prepare("SELECT * FROM credentials ORDER BY credential_id").all().map(parseCredentialRow);
	}

	save(records: readonly CredentialRecord[]): void {
		this.transaction(() => {
			this.db.exec("DELETE FROM credentials; DELETE FROM leases; DELETE FROM state;");
			for (const record of records) this.upsertCredential(record);
		});
	}

	upsertCredential(record: CredentialRecord): void {
		this.db
			.prepare(`INSERT INTO credentials (credential_id, provider, type, identity_key, material, created_at, updated_at, disabled_at, disabled_cause)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(provider, type, identity_key) DO UPDATE SET material=excluded.material, updated_at=excluded.updated_at, disabled_at=excluded.disabled_at, disabled_cause=excluded.disabled_cause`)
			.run(
				record.credentialId,
				record.pool.provider,
				record.pool.type,
				record.identityKey,
				JSON.stringify(record.material),
				record.createdAt,
				record.updatedAt,
				record.disabled?.at ?? null,
				record.disabled?.cause ?? null,
			);
	}

	disableCredential(credentialId: string, cause: string, at = new Date().toISOString()): void {
		const result = this.db
			.prepare("UPDATE credentials SET disabled_at=?, disabled_cause=?, updated_at=? WHERE credential_id=?")
			.run(at, cause, at, credentialId);
		if (result.changes !== 1) throw new AuthBrokerError("Credential was not found");
	}

	deleteCredentialsForProvider(provider: string): number {
		return this.transaction(() => {
			this.db
				.prepare(
					"DELETE FROM leases WHERE credential_id IN (SELECT credential_id FROM credentials WHERE provider=?)",
				)
				.run(provider);
			return Number(this.db.prepare("DELETE FROM credentials WHERE provider=?").run(provider).changes);
		});
	}

	metadataSnapshot(): MetadataSnapshot {
		return { credentials: this.load().map(toMetadata), generatedAt: new Date().toISOString() };
	}

	issueSelectionLease(request: SelectionLeaseRequest, authentication: string): PendingSelectionLease {
		return this.transaction(() => {
			const record = this.select(request);
			const leaseId = randomUUID();
			this.db
				.prepare(
					"INSERT INTO leases (lease_id, credential_id, authentication_hash, selector, pool, session_id) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.run(
					leaseId,
					record.credentialId,
					digest(authentication),
					JSON.stringify(request.selector),
					JSON.stringify(request.pool),
					request.sessionId ?? null,
				);
			return {
				credentialId: record.credentialId,
				leaseId,
				pool: record.pool,
				selector: request.selector,
				sessionId: request.sessionId,
			};
		});
	}

	consumeSelectionLease(request: ConsumeSelectionLeaseRequest): SelectionLease {
		return this.transaction(() => {
			const leaseRow = this.db
				.prepare("SELECT authentication_hash, credential_id, consumed_at FROM leases WHERE lease_id=?")
				.get(request.leaseId);
			const lease = leaseRow === undefined ? undefined : parseLeaseRow(leaseRow);
			if (lease === undefined || lease.consumed_at !== null)
				throw new AuthBrokerError("Selection lease is no longer available");
			if (!safeEqual(lease.authentication_hash, digest(request.authentication)))
				throw new AuthBrokerError("Selection lease authentication failed");
			const consumedAt = new Date().toISOString();
			if (
				this.db
					.prepare("UPDATE leases SET consumed_at=? WHERE lease_id=? AND consumed_at IS NULL")
					.run(consumedAt, request.leaseId).changes !== 1
			)
				throw new AuthBrokerError("Selection lease is no longer available");
			const record = this.getCredential(lease.credential_id);
			return {
				credentialId: record.credentialId,
				leaseId: request.leaseId,
				material: record.material,
				pool: record.pool,
				selector: { kind: "credential", credentialId: record.credentialId },
				reportOutcome: (report) =>
					this.reportLeaseOutcome(request.leaseId, request.authentication, {
						...report,
						credentialId: record.credentialId,
						pool: record.pool,
					}),
			};
		});
	}

	reportUsage(report: UsageReport): void {
		this.recordUsage(report);
	}

	reportLeaseOutcome(leaseId: string, authentication: string, report: UsageReport): boolean {
		return this.transaction(() => {
			const owner = this.leaseOwner(leaseId);
			if (owner === undefined || !safeEqual(owner, digest(authentication)))
				throw new AuthBrokerError("Outcome reporter is not the lease owner");
			const updated = this.db
				.prepare("UPDATE leases SET outcome=? WHERE lease_id=? AND consumed_at IS NOT NULL AND outcome IS NULL")
				.run(JSON.stringify(report), leaseId);
			if (updated.changes !== 1) return false;
			this.recordUsage(report);
			return true;
		});
	}

	credential(credentialId: string): CredentialRecord {
		return this.getCredential(credentialId);
	}

	leaseCredential(leaseId: string): string | undefined {
		const row = this.db.prepare("SELECT credential_id FROM leases WHERE lease_id=?").get(leaseId);
		return row === undefined ? undefined : readString(row, "credential_id");
	}

	private leaseOwner(leaseId: string): string | undefined {
		const row = this.db.prepare("SELECT authentication_hash FROM leases WHERE lease_id=?").get(leaseId);
		return row === undefined ? undefined : readString(row, "authentication_hash");
	}

	private migrate(): void {
		this.db.exec(`CREATE TABLE IF NOT EXISTS credentials (credential_id TEXT PRIMARY KEY, provider TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('api_key','oauth')), identity_key TEXT NOT NULL, material TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, disabled_at TEXT, disabled_cause TEXT, UNIQUE(provider, type, identity_key));
		CREATE TABLE IF NOT EXISTS leases (lease_id TEXT PRIMARY KEY, credential_id TEXT NOT NULL REFERENCES credentials(credential_id), authentication_hash TEXT NOT NULL, selector TEXT NOT NULL, pool TEXT NOT NULL, session_id TEXT, consumed_at TEXT, outcome TEXT);
		CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
	}

	private select(request: SelectionLeaseRequest): CredentialRecord {
		const poolKey = credentialPoolKey(request.pool);
		const rows: CredentialRecord[] = this.db
			.prepare(
				"SELECT * FROM credentials WHERE provider=? AND type=? AND disabled_at IS NULL ORDER BY credential_id",
			)
			.all(request.pool.provider, request.pool.type)
			.map((row: Record<string, unknown>) => parseCredentialRow(row));
		const filtered = rows
			.filter((row) => matchesSelector(row, request.selector))
			.filter((row) => !this.coolingDown(row.credentialId));
		if (filtered.length === 0)
			throw new AuthBrokerError(
				request.selector.kind === "automatic"
					? "No eligible credential is available"
					: "No eligible credential matches selector",
			);
		if (request.selector.kind === "automatic" && request.sessionId !== undefined) {
			const affinity = this.getState(`affinity:${poolKey}:${request.sessionId}`);
			const sticky = filtered.find((row) => row.credentialId === affinity);
			if (sticky !== undefined) return sticky;
		}
		const highest = Math.max(...filtered.map((row) => Number(this.getState(`usage:${row.credentialId}`) ?? "1")));
		const best = filtered.filter((row) => Number(this.getState(`usage:${row.credentialId}`) ?? "1") === highest);
		const cursor = Number(this.getState(`cursor:${poolKey}`) ?? "0");
		const selected = best[cursor % best.length];
		if (selected === undefined) throw new AuthBrokerError("No eligible credential is available");
		this.setState(`cursor:${poolKey}`, String(cursor + 1));
		if (request.selector.kind === "automatic" && request.sessionId !== undefined)
			this.setState(`affinity:${poolKey}:${request.sessionId}`, selected.credentialId);
		return selected;
	}

	private recordUsage(report: UsageReport): void {
		if (report.remainingFraction !== undefined)
			this.setState(`usage:${report.credentialId}`, String(report.remainingFraction));
		const cooldown = cooldownFor(report.status);
		if (cooldown !== undefined) this.setState(`cooldown:${report.credentialId}`, String(Date.now() + cooldown));
	}

	private coolingDown(credentialId: string): boolean {
		const until = Number(this.getState(`cooldown:${credentialId}`) ?? "0");
		return until > Date.now();
	}

	private getCredential(credentialId: string): CredentialRecord {
		const row = this.db.prepare("SELECT * FROM credentials WHERE credential_id=?").get(credentialId);
		if (row === undefined) throw new AuthBrokerError("Credential was not found");
		return parseCredentialRow(row);
	}

	private getState(key: string): string | undefined {
		const row = this.db.prepare("SELECT value FROM state WHERE key=?").get(key);
		return row === undefined ? undefined : readString(row, "value");
	}

	private setState(key: string, value: string): void {
		this.db
			.prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
			.run(key, value);
	}

	private transaction<T>(operation: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
}

export class AuthBrokerService {
	private readonly refreshes = new Map<string, Promise<CredentialMaterial>>();
	private readonly vault: SqliteCredentialVault;
	private readonly clients: readonly BrokerClient[];
	private readonly refreshCredential?: RefreshCredential;

	constructor(vault: SqliteCredentialVault, clients: readonly BrokerClient[], refreshCredential?: RefreshCredential) {
		this.vault = vault;
		this.clients = clients;
		this.refreshCredential = refreshCredential;
	}

	async handle(rawRequest: unknown, authentication: string): Promise<AuthBrokerWireResponse> {
		const request = parseAuthBrokerWireRequest(rawRequest);
		const client = this.client(authentication);
		if (!client.capabilities.includes(request.capability))
			throw new AuthBrokerError("Broker client is not authorized for this capability");
		if (request.operation === "metadata_snapshot")
			return {
				operation: request.operation,
				protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
				requestId: request.requestId,
				snapshot: this.vault.metadataSnapshot(),
			};
		if (request.operation === "selection_lease") {
			if (!client.trustedGateway)
				throw new AuthBrokerError("Broker client is not authorized for selection material");
			const pending = this.vault.issueSelectionLease({ ...request.payload }, authentication);
			const lease = this.vault.consumeSelectionLease({ authentication, leaseId: pending.leaseId });
			const material =
				lease.material.type === "api_key"
					? { apiKey: lease.material.apiKey, type: "api_key" as const }
					: {
							accessToken: lease.material.accessToken,
							expiresAt: lease.material.expiresAt,
							type: "oauth" as const,
						};
			return {
				lease: { credentialId: lease.credentialId, leaseId: lease.leaseId, material, pool: lease.pool },
				operation: request.operation,
				protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
				requestId: request.requestId,
			};
		}
		if (request.operation === "disable") {
			this.vault.disableCredential(request.payload.credentialId, request.payload.cause);
			return {
				disabledAt: new Date().toISOString(),
				operation: request.operation,
				protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
				requestId: request.requestId,
			};
		}
		if (request.operation === "outcome_report") return this.outcome(request, authentication);
		return this.refresh(request);
	}

	isAuthorized(authentication: string): boolean {
		return this.clients.some((client) => safeEqual(digest(client.authentication), digest(authentication)));
	}

	private outcome(
		request: Extract<AuthBrokerWireRequest, { readonly operation: "outcome_report" }>,
		authentication: string,
	): AuthBrokerWireResponse {
		const credentialId = this.leaseCredential(request.payload.leaseId);
		const credential = this.vault.credential(credentialId);
		this.vault.reportLeaseOutcome(request.payload.leaseId, authentication, {
			...request.payload,
			credentialId,
			pool: credential.pool,
		});
		return {
			operation: request.operation,
			protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
			recorded: true,
			requestId: request.requestId,
		};
	}

	private async refresh(
		request: Extract<AuthBrokerWireRequest, { readonly operation: "refresh" }>,
	): Promise<AuthBrokerWireResponse> {
		await this.refreshCredentialById(request.payload.credentialId);
		return {
			operation: request.operation,
			protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
			refreshedAt: new Date().toISOString(),
			requestId: request.requestId,
		};
	}

	/**
	 * Shared single-flight refresh core used by both the `refresh` wire operation
	 * and the background refresher. Throws when refresh is not configured or the
	 * credential is missing so callers can classify the failure.
	 */
	async refreshCredentialById(credentialId: string): Promise<CredentialMaterial> {
		if (this.refreshCredential === undefined) throw new AuthBrokerError("Credential refresh is not configured");
		const credential = this.vault.credential(credentialId);
		const existing = this.refreshes.get(credential.credentialId);
		const refresh =
			existing ?? this.refreshCredential(credential).finally(() => this.refreshes.delete(credential.credentialId));
		this.refreshes.set(credential.credentialId, refresh);
		const material = await refresh;
		this.vault.upsertCredential({ ...credential, material, updatedAt: new Date().toISOString() });
		return material;
	}

	/**
	 * Background sweep: refresh OAuth credentials expiring within `refreshSkewMs`
	 * of `now`, disabling any that fail definitively (invalid_grant / bare 401).
	 * Transient failures are left for the next sweep. No-op when refresh is not
	 * configured, so a freshly-booted broker without a refresh callback is inert.
	 */
	async sweepExpiringCredentials(options: {
		readonly now: number;
		readonly refreshSkewMs: number;
	}): Promise<{ readonly checked: number; readonly disabled: number; readonly refreshed: number }> {
		if (this.refreshCredential === undefined) return { checked: 0, disabled: 0, refreshed: 0 };
		const deadline = options.now + options.refreshSkewMs;
		let checked = 0;
		let refreshed = 0;
		let disabled = 0;
		for (const record of this.vault.load()) {
			if (record.disabled !== undefined || record.material.type !== "oauth") continue;
			const expiresAt = record.material.expiresAt;
			if (!Number.isFinite(expiresAt) || expiresAt > deadline) continue;
			checked += 1;
			try {
				await this.refreshCredentialById(record.credentialId);
				refreshed += 1;
			} catch (error) {
				if (isDefinitiveOAuthFailure(error instanceof Error ? error.message : String(error))) {
					try {
						this.vault.disableCredential(record.credentialId, "oauth refresh failed definitively");
						disabled += 1;
					} catch {
						// A peer/login rotated the row since the snapshot; the live
						// credential is intentionally kept. Leave it for the next sweep.
					}
				}
			}
		}
		return { checked, disabled, refreshed };
	}

	private client(authentication: string): BrokerClient {
		const candidate = this.clients.find((client) => safeEqual(digest(client.authentication), digest(authentication)));
		if (candidate === undefined) throw new AuthBrokerError("Broker client is not authorized");
		return candidate;
	}

	private leaseCredential(leaseId: string): string {
		const record = this.vault.leaseCredential(leaseId);
		if (record === undefined) throw new AuthBrokerError("Unknown selection lease");
		return record;
	}
}

function parseCredentialRow(row: Record<string, unknown>): CredentialRecord {
	const type = readType(row, "type");
	const material = parseMaterial(JSON.parse(readString(row, "material")));
	const disabledAt = readNullableString(row, "disabled_at");
	const disabledCause = readNullableString(row, "disabled_cause");
	return {
		createdAt: readString(row, "created_at"),
		credentialId: readString(row, "credential_id"),
		disabled: disabledAt === null || disabledCause === null ? undefined : { at: disabledAt, cause: disabledCause },
		identityKey: readString(row, "identity_key"),
		material,
		pool: { provider: readString(row, "provider"), type },
		updatedAt: readString(row, "updated_at"),
	};
}
function toMetadata(record: CredentialRecord): CredentialMetadata {
	return {
		createdAt: record.createdAt,
		credentialId: record.credentialId,
		disabled: record.disabled,
		identityKey: record.identityKey,
		pool: record.pool,
		updatedAt: record.updatedAt,
	};
}
function matchesSelector(record: CredentialRecord, selector: CredentialSelector): boolean {
	return (
		selector.kind === "automatic" ||
		(selector.kind === "credential"
			? record.credentialId === selector.credentialId
			: record.identityKey === selector.identityKey)
	);
}
function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
function safeEqual(left: string, right: string): boolean {
	return timingSafeEqual(new TextEncoder().encode(left), new TextEncoder().encode(right));
}
function cooldownFor(status: UsageReport["status"]): number | undefined {
	return status === "success" ? undefined : COOL_DOWN_MS[status];
}
function isDefinitiveOAuthFailure(message: string): boolean {
	const lower = message.toLowerCase();
	return lower.includes("invalid_grant") || lower.includes("invalid grant") || /\b401\b/.test(lower);
}
function readString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string") throw new AuthBrokerError("Invalid broker database row");
	return value;
}
function readNullableString(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	if (typeof value === "string" || value === null) return value;
	throw new AuthBrokerError("Invalid broker database row");
}
function readType(record: Record<string, unknown>, key: string): CredentialPool["type"] {
	const value = readString(record, key);
	if (value === "api_key" || value === "oauth") return value;
	throw new AuthBrokerError("Invalid broker database row");
}
function parseMaterial(value: unknown): CredentialMaterial {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new AuthBrokerError("Invalid broker database row");
	const material = Object.fromEntries(Object.entries(value));
	if (material.type === "api_key" && typeof material.apiKey === "string")
		return { apiKey: material.apiKey, type: "api_key" };
	if (
		material.type === "oauth" &&
		typeof material.accessToken === "string" &&
		typeof material.refreshToken === "string" &&
		typeof material.expiresAt === "number"
	)
		return {
			accessToken: material.accessToken,
			expiresAt: material.expiresAt,
			refreshToken: material.refreshToken,
			type: "oauth",
		};
	throw new AuthBrokerError("Invalid broker database row");
}
function parseLeaseRow(row: Record<string, unknown>): {
	readonly authentication_hash: string;
	readonly credential_id: string;
	readonly consumed_at: string | null;
} {
	return {
		authentication_hash: readString(row, "authentication_hash"),
		credential_id: readString(row, "credential_id"),
		consumed_at: readNullableString(row, "consumed_at"),
	};
}
