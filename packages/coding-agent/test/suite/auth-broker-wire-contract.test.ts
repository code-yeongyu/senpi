import { describe, expect, it } from "vitest";
import {
	AUTH_BROKER_PROTOCOL_VERSION,
	AUTH_BROKER_WIRE_FIXTURE_JSON,
	parseAuthBrokerWireRequest,
	parseAuthBrokerWireResponse,
} from "../../src/core/auth-broker-wire-contract.ts";

describe("auth broker wire contract", () => {
	it("serializes redacted snapshot and scoped selection lease contract", () => {
		// Given: the frozen protocol fixture and valid broker requests.
		const snapshotRequest = parseAuthBrokerWireRequest({
			capability: "broker.metadata.read",
			operation: "metadata_snapshot",
			protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
			requestId: "request-snapshot",
		});
		const selectionRequest = parseAuthBrokerWireRequest({
			capability: "gateway.selection.lease",
			operation: "selection_lease",
			payload: {
				pool: { provider: "openai", type: "api_key" },
				selector: { kind: "identity", identityKey: "operator:account-a" },
			},
			protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
			requestId: "request-selection",
		});
		const snapshotResponse = parseAuthBrokerWireResponse({
			operation: "metadata_snapshot",
			protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
			requestId: "request-snapshot",
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
		});

		// When: the contract is serialized.
		const serialized = JSON.stringify({ selectionRequest, snapshotRequest, snapshotResponse });

		// Then: the fixture remains versioned, redacted, and capability-scoped.
		expect(selectionRequest.capability).toBe("gateway.selection.lease");
		expect(AUTH_BROKER_WIRE_FIXTURE_JSON).toBe(
			'{"protocolVersion":1,"selectionLeaseRequest":{"capability":"gateway.selection.lease","operation":"selection_lease","payload":{"pool":{"provider":"openai","type":"api_key"},"selector":{"identityKey":"operator:account-a","kind":"identity"}},"protocolVersion":1,"requestId":"fixture-selection-lease"},"snapshot":{"credentials":[{"createdAt":"2026-07-11T00:00:00.000Z","credentialId":"credential-a","identityKey":"operator:account-a","pool":{"provider":"openai","type":"api_key"},"updatedAt":"2026-07-11T00:00:00.000Z"}],"generatedAt":"2026-07-11T00:00:00.000Z"}}',
		);
		expect(serialized).not.toContain("apiKey");
		expect(serialized).not.toContain("accessToken");
		expect(serialized).not.toContain("refreshToken");
	});

	it("rejects unknown version and capability mismatch without secret serialization", () => {
		// Given: malformed caller input with secret-like values.
		const sentinel = "broker-wire-secret-sentinel";
		const unsupportedVersion = {
			capability: "broker.metadata.read",
			operation: "metadata_snapshot",
			payload: { apiKey: sentinel },
			protocolVersion: 2,
			requestId: "request-version",
		};
		const capabilityMismatch = {
			capability: "broker.metadata.read",
			operation: "selection_lease",
			payload: { apiKey: sentinel },
			protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
			requestId: "request-capability",
		};

		// When: protocol validation rejects both inputs.
		let versionError = "";
		let capabilityError = "";
		try {
			parseAuthBrokerWireRequest(unsupportedVersion);
		} catch (error) {
			versionError = error instanceof Error ? error.message : String(error);
		}
		try {
			parseAuthBrokerWireRequest(capabilityMismatch);
		} catch (error) {
			capabilityError = error instanceof Error ? error.message : String(error);
		}

		// Then: errors are safe and no frozen fixture contains caller secrets.
		expect(versionError).toContain("Unsupported auth broker protocol version");
		expect(capabilityError).toContain("does not authorize");
		expect(versionError).not.toContain(sentinel);
		expect(capabilityError).not.toContain(sentinel);
		expect(AUTH_BROKER_WIRE_FIXTURE_JSON).not.toContain(sentinel);
	});

	it("permits only the five fixed capability-scoped operations", () => {
		const refresh = parseAuthBrokerWireRequest({
			capability: "broker.credential.refresh",
			operation: "refresh",
			payload: { credentialId: "credential-a" },
			protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
			requestId: "request-refresh",
		});
		const disable = parseAuthBrokerWireRequest({
			capability: "broker.credential.disable",
			operation: "disable",
			payload: { cause: "operator-request", credentialId: "credential-a" },
			protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
			requestId: "request-disable",
		});
		const outcome = parseAuthBrokerWireRequest({
			capability: "broker.selection.report-outcome",
			operation: "outcome_report",
			payload: { leaseId: "lease-a", observedAt: "2026-07-11T00:00:00.000Z", status: "success" },
			protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
			requestId: "request-outcome",
		});

		expect(refresh.operation).toBe("refresh");
		expect(disable.operation).toBe("disable");
		expect(outcome.operation).toBe("outcome_report");
		expect(() =>
			parseAuthBrokerWireRequest({
				capability: "broker.credential.write",
				operation: "credential_write",
				payload: { apiKey: "unexpected-secret" },
				protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
				requestId: "request-write",
			}),
		).toThrow("Invalid auth broker wire message");
		expect(() =>
			parseAuthBrokerWireResponse({
				lease: {
					credentialId: "credential-a",
					leaseId: "lease-a",
					material: { accessToken: "access", expiresAt: 1, refreshToken: "forbidden", type: "oauth" },
					pool: { provider: "openai", type: "oauth" },
				},
				operation: "selection_lease",
				protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
				requestId: "response-selection",
			}),
		).toThrow("Invalid auth broker wire message");
	});
});
