import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthBrokerService, SqliteCredentialVault } from "../../src/core/auth-broker.ts";
import { AuthBrokerRefresher, DEFAULT_AUTH_BROKER_REFRESH_SKEW_MS } from "../../src/core/auth-broker-refresher.ts";
import type { CredentialMaterial, CredentialRecord } from "../../src/core/auth-multi-account.ts";

const NOW = 1_000_000;

function createVaultPath(): { readonly cleanup: () => void; readonly path: string } {
	const dir = mkdtempSync(join(tmpdir(), "auth-broker-refresher-"));
	return { cleanup: () => rmSync(dir, { recursive: true, force: true }), path: join(dir, "vault.sqlite") };
}

function oauthCredential(credentialId: string, expiresAt: number): CredentialRecord {
	return {
		createdAt: "2026-07-11T00:00:00.000Z",
		credentialId,
		identityKey: `operator:${credentialId}`,
		material: {
			accessToken: `${credentialId}-access`,
			expiresAt,
			refreshToken: `${credentialId}-refresh`,
			type: "oauth",
		},
		pool: { provider: "openai", type: "oauth" },
		updatedAt: "2026-07-11T00:00:00.000Z",
	};
}

function refreshedMaterial(credentialId: string): CredentialMaterial {
	return {
		accessToken: `${credentialId}-access-renewed`,
		expiresAt: NOW + 10 * DEFAULT_AUTH_BROKER_REFRESH_SKEW_MS,
		refreshToken: `${credentialId}-refresh-renewed`,
		type: "oauth",
	};
}

describe("auth broker refresher", () => {
	const fixtures: Array<() => void> = [];
	afterEach(() => {
		while (fixtures.length > 0) fixtures.pop()?.();
	});

	function openVault() {
		const fixture = createVaultPath();
		fixtures.push(fixture.cleanup);
		return SqliteCredentialVault.open(fixture.path);
	}

	it("refreshes expiring OAuth credentials and leaves far-future tokens alone", async () => {
		const vault = openVault();
		vault.upsertCredential(oauthCredential("expiring", NOW + 30_000));
		vault.upsertCredential(oauthCredential("fresh", NOW + 10 * DEFAULT_AUTH_BROKER_REFRESH_SKEW_MS));
		let calls = 0;
		const broker = new AuthBrokerService(vault, [], async (record) => {
			calls += 1;
			return refreshedMaterial(record.credentialId);
		});

		const result = await broker.sweepExpiringCredentials({
			now: NOW,
			refreshSkewMs: DEFAULT_AUTH_BROKER_REFRESH_SKEW_MS,
		});

		expect(result).toEqual({ checked: 1, refreshed: 1, disabled: 0 });
		expect(calls).toBe(1);
		expect(vault.credential("expiring").material).toEqual(refreshedMaterial("expiring"));
		expect(vault.credential("fresh").material).toEqual(
			oauthCredential("fresh", NOW + 10 * DEFAULT_AUTH_BROKER_REFRESH_SKEW_MS).material,
		);
		expect(JSON.stringify(vault.metadataSnapshot())).not.toContain("renewed");
		vault.close();
	});

	it("disables credentials that fail definitively (invalid_grant) but keeps transient failures", async () => {
		const vault = openVault();
		vault.upsertCredential(oauthCredential("revoked", NOW + 10_000));
		vault.upsertCredential(oauthCredential("flakey", NOW + 10_000));
		const broker = new AuthBrokerService(vault, [], async (record) => {
			if (record.credentialId === "revoked") throw new Error("invalid_grant: refresh token expired");
			throw new Error("ECONNRESET: transient network failure");
		});

		const result = await broker.sweepExpiringCredentials({
			now: NOW,
			refreshSkewMs: DEFAULT_AUTH_BROKER_REFRESH_SKEW_MS,
		});

		expect(result).toEqual({ checked: 2, refreshed: 0, disabled: 1 });
		expect(vault.credential("revoked").disabled?.cause).toBe("oauth refresh failed definitively");
		expect(vault.credential("flakey").disabled).toBeUndefined();
		vault.close();
	});

	it("is inert when no refresh callback is configured", async () => {
		const vault = openVault();
		vault.upsertCredential(oauthCredential("expiring", NOW + 30_000));
		const broker = new AuthBrokerService(vault, []);

		const result = await broker.sweepExpiringCredentials({
			now: NOW,
			refreshSkewMs: DEFAULT_AUTH_BROKER_REFRESH_SKEW_MS,
		});

		expect(result).toEqual({ checked: 0, refreshed: 0, disabled: 0 });
		expect(vault.credential("expiring").material).toEqual(oauthCredential("expiring", NOW + 30_000).material);
		vault.close();
	});

	it("skips disabled credentials and non-OAuth material", async () => {
		const vault = openVault();
		vault.upsertCredential(oauthCredential("expiring", NOW + 30_000));
		const disabled = oauthCredential("disabled", NOW + 30_000);
		vault.upsertCredential(disabled);
		vault.disableCredential("disabled", "prior outage");
		vault.upsertCredential({
			...oauthCredential("apikey", NOW + 30_000),
			material: { apiKey: "key", type: "api_key" },
			pool: { provider: "openai", type: "api_key" },
		});
		let calls = 0;
		const broker = new AuthBrokerService(vault, [], async (record) => {
			calls += 1;
			return refreshedMaterial(record.credentialId);
		});

		const result = await broker.sweepExpiringCredentials({
			now: NOW,
			refreshSkewMs: DEFAULT_AUTH_BROKER_REFRESH_SKEW_MS,
		});

		expect(result).toEqual({ checked: 1, refreshed: 1, disabled: 0 });
		expect(calls).toBe(1);
		vault.close();
	});

	it("drives the sweep on tick and manages its schedule", async () => {
		const vault = openVault();
		vault.upsertCredential(oauthCredential("expiring", NOW + 30_000));
		let calls = 0;
		const broker = new AuthBrokerService(vault, [], async (record) => {
			calls += 1;
			return refreshedMaterial(record.credentialId);
		});
		const refresher = new AuthBrokerRefresher({
			service: broker,
			refreshSkewMs: DEFAULT_AUTH_BROKER_REFRESH_SKEW_MS,
			refreshIntervalMs: 1000,
			now: () => NOW,
		});

		expect(refresher.getSchedule().enabled).toBe(false);
		await refresher.tick();
		expect(calls).toBe(1);
		expect(refresher.getSchedule()).toEqual({
			enabled: false,
			intervalMs: 1000,
			nextSweepAt: NOW + 1000,
			skewMs: DEFAULT_AUTH_BROKER_REFRESH_SKEW_MS,
		});

		await refresher.start();
		expect(refresher.getSchedule().enabled).toBe(true);
		await refresher.stop();
		expect(refresher.getSchedule().enabled).toBe(false);
		// A second tick is idempotent: the token was already renewed far into the future.
		await refresher.tick();
		expect(calls).toBe(1);
		vault.close();
	});

	it("stop() awaits an in-flight tick before resolving", async () => {
		const vault = openVault();
		vault.upsertCredential(oauthCredential("expiring", NOW + 30_000));
		let resolveGate: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			resolveGate = resolve;
		});
		let started = false;
		const broker = new AuthBrokerService(vault, [], async (record) => {
			started = true;
			await gate;
			return refreshedMaterial(record.credentialId);
		});
		const refresher = new AuthBrokerRefresher({
			service: broker,
			refreshSkewMs: DEFAULT_AUTH_BROKER_REFRESH_SKEW_MS,
			refreshIntervalMs: 1000,
			now: () => NOW,
		});
		const starting = refresher.start();
		while (!started) await Promise.resolve();
		const stopP = Promise.resolve(refresher.stop());
		let settled = false;
		void stopP.then(() => {
			settled = true;
		});
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(settled).toBe(false);
		resolveGate();
		await Promise.all([starting, stopP]);
		vault.close();
	});
});
