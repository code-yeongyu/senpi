import { describe, expect, it, vi } from "vitest";
import {
	type CredentialRecord,
	InMemoryCredentialVault,
	type SelectionLeaseRequest,
	type UsageReport,
} from "../../src/core/auth-multi-account.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";

describe("current single-account auth storage characterization", () => {
	it("keeps one credential per provider and preserves independent providers", async () => {
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
		expect(await storage.list()).toEqual([
			{ providerId: "anthropic", type: "api_key" },
			{ providerId: "openai", type: "api_key" },
		]);
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
	it("rotates A B A and preserves a healthy session affinity", async () => {
		const secondApiKeyRecord: CredentialRecord = {
			...apiKeyRecord,
			credentialId: "credential-b",
			identityKey: "operator:account-b",
			material: { type: "api_key", apiKey: "test-api-key-b" },
		};
		const vault = InMemoryCredentialVault.fromRecords([apiKeyRecord, secondApiKeyRecord]);
		const automaticRequest: SelectionLeaseRequest = {
			pool: apiKeyRecord.pool,
			selector: { kind: "automatic" },
		};

		const selected = [
			vault.issueSelectionLease(automaticRequest, "gateway-a").credentialId,
			vault.issueSelectionLease(automaticRequest, "gateway-a").credentialId,
			vault.issueSelectionLease(automaticRequest, "gateway-a").credentialId,
		];
		expect(selected).toEqual(["credential-a", "credential-b", "credential-a"]);

		const sessionRequest: SelectionLeaseRequest = { ...automaticRequest, sessionId: "session-1" };
		expect(vault.issueSelectionLease(sessionRequest, "gateway-a").credentialId).toBe("credential-b");
		expect(vault.issueSelectionLease(sessionRequest, "gateway-a").credentialId).toBe("credential-b");
	});

	it("does not fall back from an explicit pin and cools down after 401 or 429", async () => {
		let now = 1_784_131_200_000;
		const secondApiKeyRecord: CredentialRecord = {
			...apiKeyRecord,
			credentialId: "credential-b",
			identityKey: "operator:account-b",
			material: { type: "api_key", apiKey: "test-api-key-b" },
		};
		const vault = InMemoryCredentialVault.fromRecords([apiKeyRecord, secondApiKeyRecord], undefined, () => now);
		const pinned: SelectionLeaseRequest = {
			pool: apiKeyRecord.pool,
			selector: { kind: "credential", credentialId: "credential-a" },
		};
		const automatic: SelectionLeaseRequest = { pool: apiKeyRecord.pool, selector: { kind: "automatic" } };
		const cooldownReport = (status: UsageReport["status"]): UsageReport => ({
			credentialId: "credential-a",
			observedAt: new Date(now).toISOString(),
			pool: apiKeyRecord.pool,
			status,
		});

		vault.reportUsage(cooldownReport("rate_limited"));
		expect(vault.issueSelectionLease(automatic, "gateway-a").credentialId).toBe("credential-b");
		expect(() => vault.issueSelectionLease(pinned, "gateway-a")).toThrow("No eligible credential matches selector");
		now += 30_001;
		expect(vault.issueSelectionLease(pinned, "gateway-a").credentialId).toBe("credential-a");

		vault.reportUsage(cooldownReport("unauthorized"));
		expect(vault.issueSelectionLease(automatic, "gateway-a").credentialId).toBe("credential-b");
		expect(() => vault.issueSelectionLease(pinned, "gateway-a")).toThrow("No eligible credential matches selector");
	});

	it("uses deterministic equal-score ranking and coordinates one OAuth refresh", async () => {
		const secondApiKeyRecord: CredentialRecord = {
			...apiKeyRecord,
			credentialId: "credential-b",
			identityKey: "operator:account-b",
			material: { type: "api_key", apiKey: "test-api-key-b" },
		};
		const vault = InMemoryCredentialVault.fromRecords([secondApiKeyRecord, apiKeyRecord]);
		const automatic: SelectionLeaseRequest = { pool: apiKeyRecord.pool, selector: { kind: "automatic" } };
		const first = vault.issueSelectionLease(automatic, "gateway-a");
		const second = vault.issueSelectionLease(automatic, "gateway-a");
		expect([first.credentialId, second.credentialId]).toEqual(["credential-a", "credential-b"]);
		vault.reportUsage({
			credentialId: "credential-a",
			observedAt: "2026-07-11T00:00:00.000Z",
			pool: apiKeyRecord.pool,
			remainingFraction: 0.2,
			status: "success",
		});
		expect(vault.issueSelectionLease(automatic, "gateway-a").credentialId).toBe("credential-b");

		let release: (() => void) | undefined;
		const refresh = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					release = () => resolve("fresh-access-token");
				}),
		);
		const firstRefresh = vault.runRefresh("credential-b", refresh);
		const secondRefresh = vault.runRefresh("credential-b", refresh);
		expect(firstRefresh).toBe(secondRefresh);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(release).toBeDefined();
		release?.();
		await expect(firstRefresh).resolves.toBe("fresh-access-token");
	});

	it("preserves runtime and stored API-key precedence over a configured pool", async () => {
		const vault = InMemoryCredentialVault.fromRecords([apiKeyRecord]);
		const storage = AuthStorage.inMemory({ openai: { type: "api_key", key: "stored-api-key" } });
		storage.setCredentialVault(vault);
		await expect(storage.selectPooledCredential("openai")).resolves.toBeUndefined();
		storage.remove("openai");
		storage.setRuntimeApiKey("openai", "runtime-api-key");
		await expect(storage.selectPooledCredential("openai")).resolves.toBeUndefined();
		storage.removeRuntimeApiKey("openai");
		const selected = await storage.selectPooledCredential("openai");
		expect(selected?.apiKey).toBe("test-api-key-a");
		selected?.reportOutcome("rate_limited");
		await expect(storage.selectPooledCredential("openai")).rejects.toThrow("No eligible credential is available");
	});
	it("persists two redacted credential records and consumes one authenticated lease", async () => {
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

	it("rejects an invalid selector and a replayed or unauthenticated lease without logging secrets", async () => {
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

	it("redacts malformed runtime selector errors", async () => {
		// Given: an untyped runtime selector containing caller-supplied secret-like data.
		const sentinel = "selector-secret-sentinel";
		const logs: string[] = [];
		const vault = InMemoryCredentialVault.fromRecords([apiKeyRecord], (entry) => logs.push(JSON.stringify(entry)));
		const malformedRequest = {
			pool: apiKeyRecord.pool,
			selector: { kind: "malformed", token: sentinel },
		};

		// When: runtime dispatch bypasses the compile-time selector union.
		let errorMessage = "";
		try {
			Reflect.apply(vault.issueSelectionLease, vault, [malformedRequest, "gateway-a"]);
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		}

		// Then: neither error text nor diagnostics include caller data.
		expect(errorMessage).not.toContain(sentinel);
		expect(logs.join("\n")).not.toContain(sentinel);
	});

	it("counts pool-only credentials as configured auth", async () => {
		const poolOnly = {
			...apiKeyRecord,
			pool: { provider: "custom-pool-provider", type: "api_key" as const },
			identityKey: "pool-only",
			credentialId: "pool-only-a",
		};
		const vault = InMemoryCredentialVault.fromRecords([poolOnly]);
		const storage = AuthStorage.inMemory({});
		expect(storage.hasAuth("custom-pool-provider")).toBe(false);
		storage.setCredentialVault(vault);
		expect(storage.hasAuth("custom-pool-provider")).toBe(true);
	});

	it("resolves pooled OAuth via provider getRequestAuth headers", async () => {
		const { registerOAuthProvider, resetOAuthProviders } = await import("@earendil-works/pi-ai/oauth");
		resetOAuthProviders();
		registerOAuthProvider({
			id: "openai",
			name: "OpenAI",
			login: async () => ({ access: "x", refresh: "y", expires: Date.now() + 60_000 }),
			refreshToken: async (c) => c,
			getApiKey: (c) => c.access,
			getRequestAuth: async (c) => ({
				apiKey: `exchanged:${c.access}`,
				headers: { "x-project": String(c.projectId ?? "") },
			}),
		});
		const vault = InMemoryCredentialVault.fromRecords([
			{
				...oauthRecord,
				material: {
					type: "oauth",
					accessToken: "test-access-token-b",
					refreshToken: "test-refresh-token-b",
					expiresAt: Date.now() + 60_000,
					extras: { projectId: "proj-123" },
				},
			},
		]);
		const storage = AuthStorage.inMemory({});
		storage.setCredentialVault(vault);
		const selected = await storage.selectPooledCredential("openai");
		expect(selected?.apiKey).toBe("exchanged:test-access-token-b");
		expect(selected?.headers).toEqual({ "x-project": "proj-123" });
		resetOAuthProviders();
	});
});
