import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthBrokerService, SqliteCredentialVault } from "../../src/core/auth-broker.ts";
import { AuthBrokerRemoteStore } from "../../src/core/auth-broker-remote-store.ts";
import { AUTH_BROKER_CAPABILITIES, AUTH_BROKER_PROTOCOL_VERSION } from "../../src/core/auth-broker-wire-contract.ts";

const createdAt = "2026-07-11T00:00:00.000Z";
const apiKey = "broker-test-api-key";
const refreshToken = "broker-test-refresh-token";

function createVaultPath(): { readonly cleanup: () => void; readonly path: string } {
	const directory = mkdtempSync(join(tmpdir(), "senpi-auth-broker-"));
	return {
		cleanup: () => rmSync(directory, { force: true, recursive: true }),
		path: join(directory, "broker.sqlite"),
	};
}

function apiCredential(credentialId: string, identityKey: string) {
	return {
		createdAt,
		credentialId,
		identityKey,
		material: { apiKey, type: "api_key" as const },
		pool: { provider: "openai", type: "api_key" as const },
		updatedAt: createdAt,
	};
}

describe("auth broker", () => {
	it("persists CAS selection across restart and redacts metadata snapshot", () => {
		const fixture = createVaultPath();
		try {
			const vault = SqliteCredentialVault.open(fixture.path);
			vault.upsertCredential(apiCredential("credential-a", "operator:a"));
			vault.upsertCredential({
				...apiCredential("credential-b", "operator:b"),
				material: { apiKey: "broker-test-api-key-b", type: "api_key" },
			});
			const first = vault.issueSelectionLease(
				{ pool: { provider: "openai", type: "api_key" }, selector: { kind: "automatic" } },
				"gateway-token",
			);
			vault.close();

			const restored = SqliteCredentialVault.open(fixture.path);
			const second = restored.issueSelectionLease(
				{ pool: { provider: "openai", type: "api_key" }, selector: { kind: "automatic" } },
				"gateway-token",
			);
			const snapshot = restored.metadataSnapshot();
			expect([first.credentialId, second.credentialId]).toEqual(["credential-a", "credential-b"]);
			expect(JSON.stringify(snapshot)).not.toContain(apiKey);
			expect(JSON.stringify(snapshot)).not.toContain(refreshToken);
			restored.close();
		} finally {
			fixture.cleanup();
		}
	});

	it("denies generic write and unauthorized capability calls without returning credentials", async () => {
		const fixture = createVaultPath();
		try {
			const vault = SqliteCredentialVault.open(fixture.path);
			vault.upsertCredential(apiCredential("credential-a", "operator:a"));
			const broker = new AuthBrokerService(vault, [
				{
					authentication: "metadata-token",
					capabilities: [AUTH_BROKER_CAPABILITIES.metadataRead],
					trustedGateway: false,
				},
			]);
			await expect(
				broker.handle(
					{
						capability: AUTH_BROKER_CAPABILITIES.selectionLease,
						operation: "selection_lease",
						payload: { pool: { provider: "openai", type: "api_key" }, selector: { kind: "automatic" } },
						protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
						requestId: "selection-denied",
					},
					"metadata-token",
				),
			).rejects.toThrow("not authorized");
			await expect(
				broker.handle(
					{
						capability: AUTH_BROKER_CAPABILITIES.metadataRead,
						operation: "credential_write",
						payload: { apiKey },
						protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
						requestId: "generic-write-denied",
					},
					"metadata-token",
				),
			).rejects.toThrow("Invalid auth broker wire message");
			vault.close();
		} finally {
			fixture.cleanup();
		}
	});

	it("deduplicates identities and single-flights capability-scoped refresh", async () => {
		const fixture = createVaultPath();
		try {
			const vault = SqliteCredentialVault.open(fixture.path);
			vault.upsertCredential({
				...apiCredential("oauth-a", "operator:oauth-a"),
				material: { accessToken: "old-access", expiresAt: 1, refreshToken, type: "oauth" },
				pool: { provider: "openai", type: "oauth" },
			});
			vault.upsertCredential({
				...apiCredential("oauth-replacement", "operator:oauth-a"),
				material: { accessToken: "replaced-access", expiresAt: 2, refreshToken, type: "oauth" },
				pool: { provider: "openai", type: "oauth" },
			});
			expect(vault.load()).toHaveLength(1);
			let calls = 0;
			const broker = new AuthBrokerService(
				vault,
				[
					{
						authentication: "refresh-token",
						capabilities: [AUTH_BROKER_CAPABILITIES.refresh],
						trustedGateway: false,
					},
				],
				async () => {
					calls += 1;
					return { accessToken: "new-access", expiresAt: 3, refreshToken, type: "oauth" };
				},
			);
			const request = {
				capability: AUTH_BROKER_CAPABILITIES.refresh,
				operation: "refresh" as const,
				payload: { credentialId: "oauth-replacement" },
				protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
				requestId: "refresh",
			};
			await Promise.all([
				broker.handle(request, "refresh-token"),
				broker.handle({ ...request, requestId: "refresh-2" }, "refresh-token"),
			]);
			expect(calls).toBe(1);
			expect(JSON.stringify(vault.metadataSnapshot())).not.toContain("new-access");
			vault.close();
		} finally {
			fixture.cleanup();
		}
	});

	it("keeps remote metadata reads fresh without exposing generic writes", async () => {
		let requests = 0;
		const remote = new AuthBrokerRemoteStore({
			async request(request) {
				requests += 1;
				return {
					operation: "metadata_snapshot",
					protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
					requestId:
						typeof request === "object" &&
						request !== null &&
						"requestId" in request &&
						typeof request.requestId === "string"
							? request.requestId
							: "missing",
					snapshot: { credentials: [], generatedAt: createdAt },
				};
			},
		});
		await remote.metadataSnapshot();
		await remote.metadataSnapshot();
		expect(requests).toBe(1);
		expect("save" in remote).toBe(false);
	});
});
