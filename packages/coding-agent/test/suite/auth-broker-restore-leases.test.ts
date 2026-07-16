import { describe, expect, it } from "vitest";
import { SqliteCredentialVault } from "../../src/core/auth-broker.ts";
import type { CredentialRecord } from "../../src/core/auth-multi-account.ts";

describe("auth broker restore with leases", () => {
	it("replaces credentials after clearing dependent leases", () => {
		// Given: a vault whose current credential has an existing consumed lease.
		const vault = SqliteCredentialVault.open(":memory:");
		try {
			vault.upsertCredential(credential("credential-old"));
			const pending = vault.issueSelectionLease(
				{ pool: { provider: "openai", type: "api_key" }, selector: { kind: "automatic" } },
				"gateway-token",
			);
			vault.consumeSelectionLease({ authentication: "gateway-token", leaseId: pending.leaseId });

			// When: restore atomically replaces the credential snapshot.
			const restore = () => vault.save([credential("credential-new")]);

			// Then: foreign-key ordering does not reject restore and only the replacement remains.
			expect(restore).not.toThrow();
			expect(vault.load().map((record) => record.credentialId)).toEqual(["credential-new"]);
		} finally {
			vault.close();
		}
	});
});

function credential(credentialId: string): CredentialRecord {
	return {
		createdAt: "2026-07-11T00:00:00.000Z",
		credentialId,
		identityKey: `operator:${credentialId}`,
		material: { apiKey: `key-${credentialId}`, type: "api_key" },
		pool: { provider: "openai", type: "api_key" },
		updatedAt: "2026-07-11T00:00:00.000Z",
	};
}
