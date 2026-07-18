import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteCredentialVault } from "../../src/core/auth-broker.ts";
import type { CredentialRecord } from "../../src/core/auth-multi-account.ts";

function vaultPath(): { cleanup: () => void; path: string } {
	const directory = mkdtempSync(join(tmpdir(), "senpi-broker-p1-"));
	return {
		cleanup: () => rmSync(directory, { force: true, recursive: true }),
		path: join(directory, "broker.sqlite"),
	};
}

function oauthRecord(overrides: Partial<CredentialRecord> = {}): CredentialRecord {
	const now = new Date().toISOString();
	return {
		createdAt: now,
		credentialId: "oauth-a",
		identityKey: "user-a",
		material: {
			type: "oauth",
			accessToken: "access-a",
			refreshToken: "refresh-a",
			expiresAt: Date.now() + 60_000,
			extras: { projectId: "proj-keep" },
		},
		pool: { provider: "google-gemini-cli", type: "oauth" },
		updatedAt: now,
		...overrides,
	};
}

describe("auth broker review P1 regressions", () => {
	it("preserves OAuth extras such as projectId through vault round-trip", () => {
		const fixture = vaultPath();
		try {
			const vault = SqliteCredentialVault.open(fixture.path);
			vault.upsertCredential(oauthRecord());
			const loaded = vault.credential("oauth-a");
			expect(loaded.material.type).toBe("oauth");
			if (loaded.material.type === "oauth") {
				expect(loaded.material.extras).toEqual({ projectId: "proj-keep" });
			}
			vault.close();
		} finally {
			fixture.cleanup();
		}
	});

	it("redacts secrets in disabled.cause on import/upsert", () => {
		const fixture = vaultPath();
		try {
			const vault = SqliteCredentialVault.open(fixture.path);
			vault.upsertCredential(
				oauthRecord({
					disabled: {
						at: new Date().toISOString(),
						cause: "refresh failed bearer sk-secret-value-12345 invalid_grant",
					},
				}),
			);
			const loaded = vault.credential("oauth-a");
			expect(loaded.disabled?.cause).toBeDefined();
			expect(loaded.disabled?.cause).not.toContain("sk-secret-value-12345");
			expect(loaded.disabled?.cause?.toLowerCase()).toContain("[redacted]");
			vault.close();
		} finally {
			fixture.cleanup();
		}
	});

	it("CAS-guards disable so a re-login that keeps credential_id is not disabled", () => {
		const fixture = vaultPath();
		try {
			const vault = SqliteCredentialVault.open(fixture.path);
			vault.upsertCredential(
				oauthRecord({
					material: {
						type: "oauth",
						accessToken: "old",
						refreshToken: "refresh-a",
						expiresAt: Date.now() - 1_000,
					},
				}),
			);
			const snapshotUpdatedAt = vault.credential("oauth-a").updatedAt;

			// Concurrent re-login keeps credential_id, bumps updatedAt + material.
			vault.upsertCredential(
				oauthRecord({
					updatedAt: new Date(Date.now() + 1_000).toISOString(),
					material: {
						type: "oauth",
						accessToken: "new-access",
						refreshToken: "new-refresh",
						expiresAt: Date.now() + 60_000,
						extras: { projectId: "proj-keep" },
					},
				}),
			);

			const disabled = vault.disableCredentialIfUnchanged(
				"oauth-a",
				snapshotUpdatedAt,
				"oauth refresh failed definitively invalid_grant",
			);
			expect(disabled).toBe(false);
			expect(vault.credential("oauth-a").disabled).toBeUndefined();
			expect((vault.credential("oauth-a").material as { accessToken: string }).accessToken).toBe("new-access");
			vault.close();
		} finally {
			fixture.cleanup();
		}
	});

	it("rejects expired unconsumed leases and prunes them", () => {
		const fixture = vaultPath();
		try {
			const vault = SqliteCredentialVault.open(fixture.path);
			vault.upsertCredential(oauthRecord());
			const pending = vault.issueSelectionLease(
				{ pool: { provider: "google-gemini-cli", type: "oauth" }, selector: { kind: "automatic" } },
				"auth",
			);
			// Expire the lease via a second vault handle to avoid private field access.
			const admin = SqliteCredentialVault.open(fixture.path);
			const prunedBefore = admin.pruneExpiredLeases(new Date(Date.now() + 20 * 60_000));
			expect(prunedBefore).toBeGreaterThanOrEqual(1);
			admin.close();
			expect(() =>
				vault.consumeSelectionLease({ authentication: "auth", leaseId: pending.leaseId }),
			).toThrow(/no longer available/i);
			vault.close();
		} finally {
			fixture.cleanup();
		}
	});
});
