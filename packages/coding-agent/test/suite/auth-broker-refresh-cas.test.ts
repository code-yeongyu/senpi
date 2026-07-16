import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthBrokerService, SqliteCredentialVault } from "../../src/core/auth-broker.ts";
import { AUTH_BROKER_CAPABILITIES, AUTH_BROKER_PROTOCOL_VERSION } from "../../src/core/auth-broker-wire-contract.ts";

const createdAt = "2026-07-11T00:00:00.000Z";
const refreshToken = "rt";

type OauthMaterial = { accessToken: string; expiresAt: number; refreshToken: string; type: "oauth" };

function vaultPath(): { cleanup: () => void; path: string } {
	const directory = mkdtempSync(join(tmpdir(), "senpi-broker-cas-"));
	return {
		cleanup: () => rmSync(directory, { force: true, recursive: true }),
		path: join(directory, "broker.sqlite"),
	};
}

function oauth(credentialId: string, identityKey: string, accessToken: string, updatedAt = createdAt, expiresAt = 1) {
	return {
		createdAt,
		credentialId,
		identityKey,
		material: { accessToken, expiresAt, refreshToken, type: "oauth" as const },
		pool: { provider: "openai", type: "oauth" as const },
		updatedAt,
	};
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolver) => {
		resolve = resolver;
	});
	return { promise, resolve };
}

function refreshClient() {
	return {
		authentication: "refresh-token",
		capabilities: [AUTH_BROKER_CAPABILITIES.refresh],
		trustedGateway: false,
	};
}

function refreshRequest(credentialId: string, requestId = "refresh") {
	return {
		capability: AUTH_BROKER_CAPABILITIES.refresh,
		operation: "refresh" as const,
		payload: { credentialId },
		protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
		requestId,
	};
}

describe("auth broker refresh CAS", () => {
	it("does not clear a disabled state when refresh completes after disable", async () => {
		const fixture = vaultPath();
		try {
			const vault = SqliteCredentialVault.open(fixture.path);
			vault.upsertCredential(oauth("oauth-a", "operator:a", "old-access"));
			const started = deferred<void>();
			const gate = deferred<OauthMaterial>();
			const broker = new AuthBrokerService(vault, [refreshClient()], async () => {
				started.resolve();
				return await gate.promise;
			});
			const pending = broker.handle(refreshRequest("oauth-a"), "refresh-token");
			await started.promise;
			vault.disableCredential("oauth-a", "operator disabled");
			gate.resolve({ accessToken: "new-access", expiresAt: 9, refreshToken, type: "oauth" });
			await pending;
			const after = vault.credential("oauth-a");
			expect(after.disabled).toBeDefined();
			expect(after.material).toEqual({ accessToken: "old-access", expiresAt: 1, refreshToken, type: "oauth" });
			vault.close();
		} finally {
			fixture.cleanup();
		}
	});

	it("does not overwrite newer material when a stale refresh completes after re-login", async () => {
		const fixture = vaultPath();
		try {
			const vault = SqliteCredentialVault.open(fixture.path);
			vault.upsertCredential(oauth("oauth-a", "operator:a", "old-access", "2026-07-11T00:00:00.000Z"));
			const started = deferred<void>();
			const gate = deferred<OauthMaterial>();
			const broker = new AuthBrokerService(vault, [refreshClient()], async () => {
				started.resolve();
				return await gate.promise;
			});
			const pending = broker.handle(refreshRequest("oauth-a"), "refresh-token");
			await started.promise;
			vault.upsertCredential(oauth("oauth-a", "operator:a", "relogin-access", "2026-07-11T01:00:00.000Z", 50));
			gate.resolve({ accessToken: "stale-access", expiresAt: 9, refreshToken, type: "oauth" });
			await pending;
			const after = vault.credential("oauth-a");
			expect(after.material).toEqual({ accessToken: "relogin-access", expiresAt: 50, refreshToken, type: "oauth" });
			vault.close();
		} finally {
			fixture.cleanup();
		}
	});

	it("does not resurrect a credential deleted (logout) while refresh is in flight", async () => {
		const fixture = vaultPath();
		try {
			const vault = SqliteCredentialVault.open(fixture.path);
			vault.upsertCredential(oauth("oauth-a", "operator:a", "old-access"));
			const started = deferred<void>();
			const gate = deferred<OauthMaterial>();
			const broker = new AuthBrokerService(vault, [refreshClient()], async () => {
				started.resolve();
				return await gate.promise;
			});
			const pending = broker.handle(refreshRequest("oauth-a"), "refresh-token");
			await started.promise;
			vault.deleteCredentialsForProvider("openai");
			gate.resolve({ accessToken: "new-access", expiresAt: 9, refreshToken, type: "oauth" });
			await pending;
			expect(vault.load()).toHaveLength(0);
			vault.close();
		} finally {
			fixture.cleanup();
		}
	});
});
