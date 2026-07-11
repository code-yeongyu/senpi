/**
 * Versioned, capability-scoped messages for the trusted auth broker boundary.
 *
 * This contract intentionally exposes no generic credential write operation.
 */

export const AUTH_BROKER_PROTOCOL_VERSION = 1 as const;

export const AUTH_BROKER_CAPABILITIES = {
	disable: "broker.credential.disable",
	metadataRead: "broker.metadata.read",
	outcomeReport: "broker.selection.report-outcome",
	refresh: "broker.credential.refresh",
	selectionLease: "gateway.selection.lease",
} as const;

export type AuthBrokerCapability = (typeof AUTH_BROKER_CAPABILITIES)[keyof typeof AUTH_BROKER_CAPABILITIES];

export type AuthBrokerOperation = "metadata_snapshot" | "selection_lease" | "refresh" | "disable" | "outcome_report";

export type AuthBrokerCredentialPool = {
	readonly provider: string;
	readonly type: "api_key" | "oauth";
};

export type AuthBrokerCredentialSelector =
	| { readonly kind: "automatic" }
	| { readonly credentialId: string; readonly kind: "credential" }
	| { readonly identityKey: string; readonly kind: "identity" };

export type AuthBrokerCredentialMetadata = {
	readonly createdAt: string;
	readonly credentialId: string;
	readonly disabled?: { readonly at: string; readonly cause: string };
	readonly identityKey: string;
	readonly pool: AuthBrokerCredentialPool;
	readonly updatedAt: string;
};

export type AuthBrokerMetadataSnapshot = {
	readonly credentials: readonly AuthBrokerCredentialMetadata[];
	readonly generatedAt: string;
};

export type AuthBrokerSelectionLeaseMaterial =
	| { readonly apiKey: string; readonly type: "api_key" }
	| { readonly accessToken: string; readonly expiresAt: number; readonly type: "oauth" };

type AuthBrokerRequestBase<Operation extends AuthBrokerOperation, Capability extends AuthBrokerCapability> = {
	readonly capability: Capability;
	readonly operation: Operation;
	readonly protocolVersion: typeof AUTH_BROKER_PROTOCOL_VERSION;
	readonly requestId: string;
};

export type MetadataSnapshotRequest = AuthBrokerRequestBase<"metadata_snapshot", "broker.metadata.read">;

export type SelectionLeaseRequest = AuthBrokerRequestBase<"selection_lease", "gateway.selection.lease"> & {
	readonly payload: {
		readonly pool: AuthBrokerCredentialPool;
		readonly selector: AuthBrokerCredentialSelector;
	};
};

export type RefreshRequest = AuthBrokerRequestBase<"refresh", "broker.credential.refresh"> & {
	readonly payload: { readonly credentialId: string };
};

export type DisableRequest = AuthBrokerRequestBase<"disable", "broker.credential.disable"> & {
	readonly payload: { readonly cause: string; readonly credentialId: string };
};

export type OutcomeReportRequest = AuthBrokerRequestBase<"outcome_report", "broker.selection.report-outcome"> & {
	readonly payload: {
		readonly leaseId: string;
		readonly observedAt: string;
		readonly remainingFraction?: number;
		readonly status: "success" | "rate_limited" | "unauthorized" | "unavailable";
	};
};

export type AuthBrokerWireRequest =
	| MetadataSnapshotRequest
	| SelectionLeaseRequest
	| RefreshRequest
	| DisableRequest
	| OutcomeReportRequest;

export type MetadataSnapshotResponse = {
	readonly operation: "metadata_snapshot";
	readonly protocolVersion: typeof AUTH_BROKER_PROTOCOL_VERSION;
	readonly requestId: string;
	readonly snapshot: AuthBrokerMetadataSnapshot;
};

export type SelectionLeaseResponse = {
	readonly lease: {
		readonly credentialId: string;
		readonly leaseId: string;
		readonly material: AuthBrokerSelectionLeaseMaterial;
		readonly pool: AuthBrokerCredentialPool;
	};
	readonly operation: "selection_lease";
	readonly protocolVersion: typeof AUTH_BROKER_PROTOCOL_VERSION;
	readonly requestId: string;
};

export type RefreshResponse = {
	readonly operation: "refresh";
	readonly protocolVersion: typeof AUTH_BROKER_PROTOCOL_VERSION;
	readonly refreshedAt: string;
	readonly requestId: string;
};

export type DisableResponse = {
	readonly disabledAt: string;
	readonly operation: "disable";
	readonly protocolVersion: typeof AUTH_BROKER_PROTOCOL_VERSION;
	readonly requestId: string;
};

export type OutcomeReportResponse = {
	readonly operation: "outcome_report";
	readonly protocolVersion: typeof AUTH_BROKER_PROTOCOL_VERSION;
	readonly recorded: true;
	readonly requestId: string;
};

export type AuthBrokerWireResponse =
	| MetadataSnapshotResponse
	| SelectionLeaseResponse
	| RefreshResponse
	| DisableResponse
	| OutcomeReportResponse;

export class AuthBrokerWireProtocolError extends Error {
	readonly code: "capability_mismatch" | "invalid_message" | "unsupported_version";

	constructor(code: AuthBrokerWireProtocolError["code"], message: string) {
		super(message);
		this.name = "AuthBrokerWireProtocolError";
		this.code = code;
	}
}

export const AUTH_BROKER_WIRE_FIXTURE = {
	protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
	selectionLeaseRequest: {
		capability: AUTH_BROKER_CAPABILITIES.selectionLease,
		operation: "selection_lease",
		payload: {
			pool: { provider: "openai", type: "api_key" },
			selector: { identityKey: "operator:account-a", kind: "identity" },
		},
		protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
		requestId: "fixture-selection-lease",
	},
	snapshot: {
		credentials: [
			{
				createdAt: "2026-07-11T00:00:00.000Z",
				credentialId: "credential-a",
				identityKey: "operator:account-a",
				pool: { provider: "openai", type: "api_key" },
				updatedAt: "2026-07-11T00:00:00.000Z",
			},
		],
		generatedAt: "2026-07-11T00:00:00.000Z",
	},
} as const satisfies {
	readonly protocolVersion: typeof AUTH_BROKER_PROTOCOL_VERSION;
	readonly selectionLeaseRequest: SelectionLeaseRequest;
	readonly snapshot: AuthBrokerMetadataSnapshot;
};

export const AUTH_BROKER_WIRE_FIXTURE_JSON = JSON.stringify(AUTH_BROKER_WIRE_FIXTURE);

export function parseAuthBrokerWireRequest(value: unknown): AuthBrokerWireRequest {
	const record = parseRecord(value);
	const protocolVersion = parseProtocolVersion(record);
	const requestId = readString(record, "requestId");
	const operation = readOperation(record);
	const capability = readString(record, "capability");
	assertCapability(operation, capability);

	switch (operation) {
		case "metadata_snapshot":
			assertExactKeys(record, ["capability", "operation", "protocolVersion", "requestId"]);
			return { capability: AUTH_BROKER_CAPABILITIES.metadataRead, operation, protocolVersion, requestId };
		case "selection_lease":
			assertExactKeys(record, ["capability", "operation", "payload", "protocolVersion", "requestId"]);
			return {
				capability: AUTH_BROKER_CAPABILITIES.selectionLease,
				operation,
				payload: parseSelectionLeasePayload(record),
				protocolVersion,
				requestId,
			};
		case "refresh":
			assertExactKeys(record, ["capability", "operation", "payload", "protocolVersion", "requestId"]);
			return {
				capability: AUTH_BROKER_CAPABILITIES.refresh,
				operation,
				payload: parseCredentialPayload(record),
				protocolVersion,
				requestId,
			};
		case "disable":
			assertExactKeys(record, ["capability", "operation", "payload", "protocolVersion", "requestId"]);
			return {
				capability: AUTH_BROKER_CAPABILITIES.disable,
				operation,
				payload: parseDisablePayload(record),
				protocolVersion,
				requestId,
			};
		case "outcome_report":
			assertExactKeys(record, ["capability", "operation", "payload", "protocolVersion", "requestId"]);
			return {
				capability: AUTH_BROKER_CAPABILITIES.outcomeReport,
				operation,
				payload: parseOutcomeReportPayload(record),
				protocolVersion,
				requestId,
			};
		default:
			return assertNever(operation);
	}
}

export function parseAuthBrokerWireResponse(value: unknown): AuthBrokerWireResponse {
	const record = parseRecord(value);
	const protocolVersion = parseProtocolVersion(record);
	const requestId = readString(record, "requestId");
	const operation = readOperation(record);

	switch (operation) {
		case "metadata_snapshot":
			assertExactKeys(record, ["operation", "protocolVersion", "requestId", "snapshot"]);
			return { operation, protocolVersion, requestId, snapshot: parseSnapshot(readRecord(record, "snapshot")) };
		case "selection_lease":
			assertExactKeys(record, ["lease", "operation", "protocolVersion", "requestId"]);
			return { operation, protocolVersion, requestId, lease: parseSelectionLease(readRecord(record, "lease")) };
		case "refresh":
			assertExactKeys(record, ["operation", "protocolVersion", "refreshedAt", "requestId"]);
			return { operation, protocolVersion, refreshedAt: readString(record, "refreshedAt"), requestId };
		case "disable":
			assertExactKeys(record, ["disabledAt", "operation", "protocolVersion", "requestId"]);
			return { disabledAt: readString(record, "disabledAt"), operation, protocolVersion, requestId };
		case "outcome_report":
			assertExactKeys(record, ["operation", "protocolVersion", "recorded", "requestId"]);
			if (record.recorded !== true) throw invalidMessage();
			return { operation, protocolVersion, recorded: true, requestId };
		default:
			return assertNever(operation);
	}
}

function parseSelectionLeasePayload(record: Record<string, unknown>): SelectionLeaseRequest["payload"] {
	const payload = readRecord(record, "payload");
	assertExactKeys(payload, ["pool", "selector"]);
	return { pool: parsePool(readRecord(payload, "pool")), selector: parseSelector(readRecord(payload, "selector")) };
}

function parseCredentialPayload(record: Record<string, unknown>): RefreshRequest["payload"] {
	const payload = readRecord(record, "payload");
	assertExactKeys(payload, ["credentialId"]);
	return { credentialId: readString(payload, "credentialId") };
}

function parseDisablePayload(record: Record<string, unknown>): DisableRequest["payload"] {
	const payload = readRecord(record, "payload");
	assertExactKeys(payload, ["cause", "credentialId"]);
	return { cause: readString(payload, "cause"), credentialId: readString(payload, "credentialId") };
}

function parseOutcomeReportPayload(record: Record<string, unknown>): OutcomeReportRequest["payload"] {
	const payload = readRecord(record, "payload");
	assertExactKeys(payload, ["leaseId", "observedAt", "remainingFraction", "status"]);
	const status = readString(payload, "status");
	if (status !== "success" && status !== "rate_limited" && status !== "unauthorized" && status !== "unavailable") {
		throw invalidMessage();
	}
	const remainingFraction = payload.remainingFraction;
	if (remainingFraction !== undefined && typeof remainingFraction !== "number") throw invalidMessage();
	return {
		leaseId: readString(payload, "leaseId"),
		observedAt: readString(payload, "observedAt"),
		remainingFraction,
		status,
	};
}

function parseSnapshot(record: Record<string, unknown>): AuthBrokerMetadataSnapshot {
	assertExactKeys(record, ["credentials", "generatedAt"]);
	const credentials = record.credentials;
	if (!Array.isArray(credentials)) throw invalidMessage();
	return { credentials: credentials.map(parseCredentialMetadata), generatedAt: readString(record, "generatedAt") };
}

function parseCredentialMetadata(value: unknown): AuthBrokerCredentialMetadata {
	const record = parseRecord(value);
	assertExactKeys(record, ["createdAt", "credentialId", "disabled", "identityKey", "pool", "updatedAt"]);
	const disabled = record.disabled === undefined ? undefined : parseDisabledState(parseRecord(record.disabled));
	return {
		createdAt: readString(record, "createdAt"),
		credentialId: readString(record, "credentialId"),
		disabled,
		identityKey: readString(record, "identityKey"),
		pool: parsePool(readRecord(record, "pool")),
		updatedAt: readString(record, "updatedAt"),
	};
}

function parseDisabledState(record: Record<string, unknown>): { readonly at: string; readonly cause: string } {
	assertExactKeys(record, ["at", "cause"]);
	return { at: readString(record, "at"), cause: readString(record, "cause") };
}

function parseSelectionLease(record: Record<string, unknown>): SelectionLeaseResponse["lease"] {
	assertExactKeys(record, ["credentialId", "leaseId", "material", "pool"]);
	return {
		credentialId: readString(record, "credentialId"),
		leaseId: readString(record, "leaseId"),
		material: parseCredentialMaterial(readRecord(record, "material")),
		pool: parsePool(readRecord(record, "pool")),
	};
}

function parseCredentialMaterial(record: Record<string, unknown>): AuthBrokerSelectionLeaseMaterial {
	const type = readCredentialType(record);
	switch (type) {
		case "api_key":
			assertExactKeys(record, ["apiKey", "type"]);
			return { apiKey: readString(record, "apiKey"), type };
		case "oauth":
			assertExactKeys(record, ["accessToken", "expiresAt", "type"]);
			return {
				accessToken: readString(record, "accessToken"),
				expiresAt: readNumber(record, "expiresAt"),
				type,
			};
		default:
			return assertNever(type);
	}
}

function parsePool(record: Record<string, unknown>): AuthBrokerCredentialPool {
	assertExactKeys(record, ["provider", "type"]);
	return { provider: readString(record, "provider"), type: readCredentialType(record) };
}

function parseSelector(record: Record<string, unknown>): AuthBrokerCredentialSelector {
	const kind = readString(record, "kind");
	switch (kind) {
		case "automatic":
			assertExactKeys(record, ["kind"]);
			return { kind };
		case "credential":
			assertExactKeys(record, ["credentialId", "kind"]);
			return { credentialId: readString(record, "credentialId"), kind };
		case "identity":
			assertExactKeys(record, ["identityKey", "kind"]);
			return { identityKey: readString(record, "identityKey"), kind };
		default:
			throw invalidMessage();
	}
}

function parseProtocolVersion(record: Record<string, unknown>): typeof AUTH_BROKER_PROTOCOL_VERSION {
	const version = record.protocolVersion;
	if (version !== AUTH_BROKER_PROTOCOL_VERSION) {
		throw new AuthBrokerWireProtocolError("unsupported_version", "Unsupported auth broker protocol version");
	}
	return AUTH_BROKER_PROTOCOL_VERSION;
}

function readOperation(record: Record<string, unknown>): AuthBrokerOperation {
	const operation = readString(record, "operation");
	if (
		operation !== "metadata_snapshot" &&
		operation !== "selection_lease" &&
		operation !== "refresh" &&
		operation !== "disable" &&
		operation !== "outcome_report"
	) {
		throw invalidMessage();
	}
	return operation;
}

function assertCapability(operation: AuthBrokerOperation, capability: string): void {
	const expected = capabilityForOperation(operation);
	if (capability !== expected) {
		throw new AuthBrokerWireProtocolError(
			"capability_mismatch",
			"Auth broker capability does not authorize the requested operation",
		);
	}
}

function capabilityForOperation(operation: AuthBrokerOperation): AuthBrokerCapability {
	switch (operation) {
		case "metadata_snapshot":
			return AUTH_BROKER_CAPABILITIES.metadataRead;
		case "selection_lease":
			return AUTH_BROKER_CAPABILITIES.selectionLease;
		case "refresh":
			return AUTH_BROKER_CAPABILITIES.refresh;
		case "disable":
			return AUTH_BROKER_CAPABILITIES.disable;
		case "outcome_report":
			return AUTH_BROKER_CAPABILITIES.outcomeReport;
		default:
			return assertNever(operation);
	}
}

function readCredentialType(record: Record<string, unknown>): AuthBrokerCredentialPool["type"] {
	const type = readString(record, "type");
	if (type !== "api_key" && type !== "oauth") throw invalidMessage();
	return type;
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
	return parseRecord(record[key]);
}

function readString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) throw invalidMessage();
	return value;
}

function readNumber(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	if (typeof value !== "number" || !Number.isFinite(value)) throw invalidMessage();
	return value;
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
	if (Object.keys(record).some((key) => !keys.includes(key))) throw invalidMessage();
}

function parseRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidMessage();
	const record: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		record[key] = entry;
	}
	return record;
}

function invalidMessage(): AuthBrokerWireProtocolError {
	return new AuthBrokerWireProtocolError("invalid_message", "Invalid auth broker wire message");
}

function assertNever(value: never): never {
	void value;
	throw invalidMessage();
}
