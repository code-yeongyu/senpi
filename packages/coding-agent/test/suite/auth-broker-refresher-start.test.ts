import { describe, expect, it } from "vitest";
import { AuthBrokerService, SqliteCredentialVault } from "../../src/core/auth-broker.ts";
import { AuthBrokerRefresher } from "../../src/core/auth-broker-refresher.ts";

describe("auth broker refresher startup", () => {
	it("waits for the initial credential sweep before enabling service cadence", async () => {
		// Given: an expiring OAuth credential whose refresh is held behind a gate.
		const vault = SqliteCredentialVault.open(":memory:");
		vault.upsertCredential({
			createdAt: "2026-07-11T00:00:00.000Z",
			credentialId: "expiring",
			identityKey: "operator:expiring",
			material: {
				accessToken: "old-access",
				expiresAt: 1,
				refreshToken: "refresh",
				type: "oauth",
			},
			pool: { provider: "openai", type: "oauth" },
			updatedAt: "2026-07-11T00:00:00.000Z",
		});
		let releaseRefresh: () => void = () => {};
		const refreshGate = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		let refreshStarted = false;
		const broker = new AuthBrokerService(vault, [], async () => {
			refreshStarted = true;
			await refreshGate;
			return {
				accessToken: "new-access",
				expiresAt: Date.now() + 3_600_000,
				refreshToken: "new-refresh",
				type: "oauth",
			};
		});
		const refresher = new AuthBrokerRefresher({ service: broker });

		// When: startup begins while the initial refresh is still pending.
		let startupFinished = false;
		const startup = Promise.resolve(refresher.start()).then(() => {
			startupFinished = true;
		});
		while (!refreshStarted) await Promise.resolve();

		// Then: startup remains closed until the sweep finishes, then enables cadence.
		expect(startupFinished).toBe(false);
		expect(refresher.getSchedule().enabled).toBe(false);
		releaseRefresh();
		await startup;
		expect(refresher.getSchedule().enabled).toBe(true);
		await refresher.stop();
		vault.close();
	});
});
