import type {
	AuthBrokerCredentialPool,
	AuthBrokerCredentialSelector,
	AuthBrokerMetadataSnapshot,
	AuthBrokerWireResponse,
} from "./auth-broker-wire-contract.ts";
import { AUTH_BROKER_CAPABILITIES, AUTH_BROKER_PROTOCOL_VERSION } from "./auth-broker-wire-contract.ts";

export interface AuthBrokerRemoteTransport {
	request(request: unknown): Promise<AuthBrokerWireResponse>;
}

export class AuthBrokerRemoteStore {
	private snapshot: { readonly value: AuthBrokerMetadataSnapshot; readonly validUntil: number } | undefined;
	private snapshotFlight: Promise<AuthBrokerMetadataSnapshot> | undefined;
	private requestNumber = 0;
	private readonly transport: AuthBrokerRemoteTransport;
	private readonly snapshotFreshnessMs: number;

	constructor(transport: AuthBrokerRemoteTransport, snapshotFreshnessMs = 1_000) {
		this.transport = transport;
		this.snapshotFreshnessMs = snapshotFreshnessMs;
	}

	async metadataSnapshot(options: { readonly forceRefresh?: boolean } = {}): Promise<AuthBrokerMetadataSnapshot> {
		if (!options.forceRefresh && this.snapshot !== undefined && this.snapshot.validUntil > Date.now()) {
			return this.snapshot.value;
		}
		const existing = this.snapshotFlight;
		if (existing !== undefined) return existing;
		const flight = this.fetchSnapshot();
		this.snapshotFlight = flight;
		try {
			return await flight;
		} finally {
			if (this.snapshotFlight === flight) this.snapshotFlight = undefined;
		}
	}

	async select(
		pool: AuthBrokerCredentialPool,
		selector: AuthBrokerCredentialSelector,
		sessionId?: string,
	): Promise<Extract<AuthBrokerWireResponse, { readonly operation: "selection_lease" }>["lease"]> {
		const response = await this.transport.request({
			...this.message("selection_lease", AUTH_BROKER_CAPABILITIES.selectionLease),
			payload: { pool, selector, ...(sessionId === undefined ? {} : { sessionId }) },
		});
		if (response.operation !== "selection_lease") throw new Error("Unexpected broker response");
		return response.lease;
	}

	async refresh(credentialId: string): Promise<void> {
		const response = await this.transport.request({
			...this.message("refresh", AUTH_BROKER_CAPABILITIES.refresh),
			payload: { credentialId },
		});
		if (response.operation !== "refresh") throw new Error("Unexpected broker response");
		this.snapshot = undefined;
	}

	async disable(credentialId: string, cause: string): Promise<void> {
		const response = await this.transport.request({
			...this.message("disable", AUTH_BROKER_CAPABILITIES.disable),
			payload: { cause, credentialId },
		});
		if (response.operation !== "disable") throw new Error("Unexpected broker response");
		this.snapshot = undefined;
	}

	async reportOutcome(
		leaseId: string,
		status: "success" | "rate_limited" | "unauthorized" | "unavailable",
		observedAt: string,
		remainingFraction?: number,
	): Promise<void> {
		const payload =
			remainingFraction === undefined
				? { leaseId, observedAt, status }
				: { leaseId, observedAt, remainingFraction, status };
		const response = await this.transport.request({
			...this.message("outcome_report", AUTH_BROKER_CAPABILITIES.outcomeReport),
			payload,
		});
		if (response.operation !== "outcome_report") throw new Error("Unexpected broker response");
	}

	private message(
		operation: "metadata_snapshot" | "selection_lease" | "refresh" | "disable" | "outcome_report",
		capability: (typeof AUTH_BROKER_CAPABILITIES)[keyof typeof AUTH_BROKER_CAPABILITIES],
	) {
		this.requestNumber += 1;
		return {
			capability,
			operation,
			protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
			requestId: `remote-${this.requestNumber}`,
		};
	}

	private async fetchSnapshot(): Promise<AuthBrokerMetadataSnapshot> {
		const response = await this.transport.request(
			this.message("metadata_snapshot", AUTH_BROKER_CAPABILITIES.metadataRead),
		);
		if (response.operation !== "metadata_snapshot") throw new Error("Unexpected broker response");
		this.snapshot = { validUntil: Date.now() + this.snapshotFreshnessMs, value: response.snapshot };
		return response.snapshot;
	}
}
