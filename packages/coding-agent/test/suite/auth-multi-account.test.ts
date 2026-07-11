import { describe, expect, it } from "vitest";
import {
	type CredentialRecord,
	InMemoryCredentialVault,
	type SelectionLeaseRequest,
} from "../../src/core/auth-multi-account.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";

describe("current single-account auth storage characterization", () => {
	it("keeps one credential per provider and preserves independent providers", () => {
		// Given: the current AuthStorage with credentials for two providers.
		const storage = AuthStorage.inMemory({
			anthropic: { type: "api_key", key: "first-anthropic-key" },
			openai: { type: "api_key", key: "openai-key" },
		});

		// When: the Anthropic credential is set again.
		storage.set("anthropic", { type: "api_key", key: "second-anthropic-key" });

		// Then: it replaces that provider's sole credential without changing OpenAI.
		expect(storage.get("anthropic")).toEqual({ type: "api_key", key: "second-anthropic-key" });
		expect(storage.get("openai")).toEqual({ type: "api_key", key: "openai-key" });
		expect(storage.list()).toEqual(["anthropic", "openai"]);
	});
});

const apiKeyRecord: CredentialRecord = {
	createdAt: "2026-07-11T00:00:00.000Z",
	credentialId: "credential-a",
	identityKey: "operator:account-a",
	material: { type: "api_key", apiKey: "test-api-key-a" },
	pool: { provider: "openai", type: "api_key" },
	updatedAt: "2026-07-11T00:00:00.000Z",
};

const oauthRecord: CredentialRecord = {
	createdAt: "2026-07-11T00:00:00.000Z",
	credentialId: "credential-b",
	identityKey: "operator:account-b",
	material: {
		type: "oauth",
		accessToken: "test-access-token-b",
		expiresAt: 1_784_131_200_000,
		refreshToken: "test-refresh-token-b",
	},
	pool: { provider: "openai", type: "oauth" },
	updatedAt: "2026-07-11T00:00:00.000Z",
};

function selectionRequest(): SelectionLeaseRequest {
	return {
		pool: { provider: "openai", type: "api_key" },
		selector: { kind: "identity", identityKey: "operator:account-a" },
	};
}

describe("multi-account credential contracts", () => {
	it("persists two redacted credential records and consumes one authenticated lease", () => {
		// Given: two credentials from separate provider/type pools.
		const original = InMemoryCredentialVault.fromRecords([apiKeyRecord, oauthRecord]);

		// When: the vault is serialized, reloaded, and a trusted gateway consumes one lease.
		const restored = InMemoryCredentialVault.fromSerialized(original.serialize());
		const snapshot = restored.metadataSnapshot();
		const pendingLease = restored.issueSelectionLease(selectionRequest(), "gateway-a");
		const lease = restored.consumeSelectionLease({
			authentication: "gateway-a",
			leaseId: pendingLease.leaseId,
		});

		// Then: metadata is redacted and the selected material exists only in the consumed lease.
		expect(snapshot.credentials).toHaveLength(2);
		expect(JSON.stringify(snapshot)).not.toContain("test-api-key-a");
		expect(JSON.stringify(snapshot)).not.toContain("test-access-token-b");
		expect(JSON.stringify(snapshot)).not.toContain("test-refresh-token-b");
		expect(lease.material).toEqual({ type: "api_key", apiKey: "test-api-key-a" });
	});

	it("rejects an invalid selector and a replayed or unauthenticated lease without logging secrets", () => {
		// Given: a vault with a single API-key credential and a captured log sink.
		const logs: string[] = [];
		const vault = InMemoryCredentialVault.fromRecords([apiKeyRecord, oauthRecord], (entry) =>
			logs.push(JSON.stringify(entry)),
		);

		// When: invalid selection, unauthenticated consumption, and replay are attempted.
		expect(() =>
			vault.issueSelectionLease(
				{ pool: apiKeyRecord.pool, selector: { kind: "identity", identityKey: "missing" } },
				"gateway-a",
			),
		).toThrow("No credential matches selector");
		const pendingLease = vault.issueSelectionLease(selectionRequest(), "gateway-a");
		expect(() => vault.consumeSelectionLease({ authentication: "gateway-b", leaseId: pendingLease.leaseId })).toThrow(
			"Selection lease authentication failed",
		);
		vault.consumeSelectionLease({ authentication: "gateway-a", leaseId: pendingLease.leaseId });
		expect(() => vault.consumeSelectionLease({ authentication: "gateway-a", leaseId: pendingLease.leaseId })).toThrow(
			"Selection lease is no longer available",
		);

		// Then: diagnostics omit every credential secret.
		expect(logs.join("\n")).not.toContain("test-api-key-a");
		expect(logs.join("\n")).not.toContain("test-access-token-b");
		expect(logs.join("\n")).not.toContain("test-refresh-token-b");
	});
});
