import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshOAuthCredential } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { AuthStorage } from "../src/index.ts";

function expired(access: string): OAuthCredential {
	return { type: "oauth", access, refresh: "refresh-1", expires: Date.now() - 1_000 };
}

function fakeOAuth(onRefresh: () => void): OAuthAuth {
	return {
		name: "fake",
		login: () => Promise.reject(new Error("not used")),
		refresh: async (credential) => {
			onRefresh();
			await Promise.resolve();
			return { ...credential, access: "access-2", expires: Date.now() + 3_600_000 };
		},
		toAuth: async (credential) => ({ apiKey: credential.access }),
	};
}

describe("AuthStorage.refreshOAuthCredential (custody CK18)", () => {
	test("concurrent callers share one token exchange and all see the refreshed credential", async () => {
		const storage = AuthStorage.inMemory({ acme: expired("access-1") });
		let exchanges = 0;
		const oauth = fakeOAuth(() => exchanges++);

		const results = await Promise.all(Array.from({ length: 5 }, () => storage.refreshOAuthCredential("acme", oauth)));

		expect(exchanges).toBe(1);
		expect(results.map((credential) => credential?.access)).toEqual(Array(5).fill("access-2"));
		expect(await storage.read("acme")).toMatchObject({ type: "oauth", access: "access-2" });
	});

	test("leaves an unexpired credential untouched", async () => {
		const fresh: OAuthCredential = { type: "oauth", access: "access-1", refresh: "r", expires: Date.now() + 60_000 };
		const storage = AuthStorage.inMemory({ acme: fresh });
		let exchanges = 0;
		const refreshed = await storage.refreshOAuthCredential(
			"acme",
			fakeOAuth(() => exchanges++),
		);
		expect(exchanges).toBe(0);
		expect(refreshed?.access).toBe("access-1");
	});

	test("answers undefined for a provider without an OAuth credential", async () => {
		const storage = AuthStorage.inMemory({ acme: { type: "api_key", key: "k" } });
		expect(
			await storage.refreshOAuthCredential(
				"acme",
				fakeOAuth(() => {}),
			),
		).toBeUndefined();
		expect(
			await storage.refreshOAuthCredential(
				"absent",
				fakeOAuth(() => {}),
			),
		).toBeUndefined();
	});

	test("shares the request-time refresh lock: a store refreshing while another process runs pi-ai's request-time exchange does not exchange the same token again", async () => {
		const dir = mkdtempSync(join(tmpdir(), "auth-refresh-lock-"));
		try {
			const authPath = join(dir, "auth.json");
			AuthStorage.create(authPath).set("acme", expired("access-1"));
			const device = AuthStorage.create(authPath);
			const cli = AuthStorage.create(authPath);
			let exchanges = 0;
			const entries: Array<() => void> = [];
			const entered = (n: number) =>
				new Promise<void>((resolve) => {
					entries[n] = resolve;
				});
			const firstEntered = entered(1);
			const secondEntered = entered(2);
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const oauth: OAuthAuth = {
				...fakeOAuth(() => {}),
				refresh: async (credential) => {
					exchanges++;
					entries[exchanges]?.();
					await gate;
					return { ...credential, access: "access-2", refresh: "refresh-2", expires: Date.now() + 3_600_000 };
				},
			};
			const stale = (await cli.read("acme")) as OAuthCredential;
			const viaCli = refreshOAuthCredential({
				credentials: cli,
				providerId: "acme",
				oauth,
				stale,
				isStale: (credential) => Date.now() >= credential.expires,
				signal: new AbortController().signal,
				owning: true,
			});
			await firstEntered;
			const viaDevice = device.refreshOAuthCredential("acme", oauth);
			// Hold the CLI's exchange open until the device caller either starts a second exchange of the
			// same refresh token (the defect) or has had ample time to reach the store and wait on the lock.
			await Promise.race([secondEntered, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
			release();
			const [fromDevice, fromCli] = await Promise.all([viaDevice, viaCli]);
			expect(exchanges).toBe(1);
			expect(fromDevice?.access).toBe("access-2");
			expect(fromCli).toMatchObject({ type: "oauth", access: "access-2" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
