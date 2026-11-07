import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
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
});
