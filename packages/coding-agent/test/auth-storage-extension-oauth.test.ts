import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";

function fakeOAuth(name: string, credential: OAuthCredential): OAuthAuth {
	return {
		name,
		async login() {
			return credential;
		},
		async refresh(current) {
			return current;
		},
		async toAuth(current) {
			return { apiKey: current.access };
		},
	};
}

describe("AuthStorage extension OAuth providers", () => {
	test("extension-registered oauth provider appears in getOAuthProviders", () => {
		const storage = AuthStorage.inMemory();
		const oauth = fakeOAuth("Anthropic Subscription (Claude Pro/Max)", {
			type: "oauth",
			access: "a",
			refresh: "r",
			expires: Date.now() + 60_000,
		});
		storage.registerOAuthProvider("anthropic-subscription", oauth);
		expect(storage.getOAuthProviders()).toContainEqual({
			id: "anthropic-subscription",
			name: "Anthropic Subscription (Claude Pro/Max)",
		});
	});

	test("login() runs the extension oauth flow and stores the credential", async () => {
		const storage = AuthStorage.inMemory();
		const credential: OAuthCredential = { type: "oauth", access: "a", refresh: "r", expires: 123 };
		storage.registerOAuthProvider("anthropic-subscription", fakeOAuth("x", credential));
		await storage.login("anthropic-subscription", {
			signal: undefined,
			onPrompt: async () => "",
			onAuth: async () => {},
			onManualCodeInput: async () => "",
		} as never);
		expect(await storage.read("anthropic-subscription")).toEqual(credential);
	});

	test("unregisterOAuthProvider hides the provider again", () => {
		const storage = AuthStorage.inMemory();
		storage.registerOAuthProvider(
			"anthropic-subscription",
			fakeOAuth("x", { type: "oauth", access: "", refresh: "", expires: 0 }),
		);
		storage.unregisterOAuthProvider("anthropic-subscription");
		expect(storage.getOAuthProviders().map((p) => p.id)).not.toContain("anthropic-subscription");
	});

	test("builtin providers still enumerate after dynamic registration", () => {
		const storage = AuthStorage.inMemory();
		storage.registerOAuthProvider(
			"anthropic-subscription",
			fakeOAuth("x", { type: "oauth", access: "", refresh: "", expires: 0 }),
		);
		const ids = storage.getOAuthProviders().map((p) => p.id);
		expect(ids).toContain("anthropic");
		expect(ids).toContain("anthropic-subscription");
	});
});
