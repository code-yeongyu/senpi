import type { OAuthAuth } from "@earendil-works/pi-ai";
import { appendLoginSlot } from "@earendil-works/pi-ai/auth/pool/slots";
import { describe, expect, it } from "vitest";
import {
	type AccountSlot,
	type AnthropicSubscriptionCredential,
	emptyCredential,
	listAccounts,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { createOAuthConfig } from "../../../src/core/extensions/builtin/anthropic-subscription/oauth-login.ts";

function fakeFlow(credential: { access: string; refresh: string; expires: number }): OAuthAuth {
	return {
		name: "fake",
		async login() {
			return { type: "oauth", ...credential };
		},
		async refresh(current) {
			return current;
		},
		async toAuth(current) {
			return { apiKey: current.access };
		},
	};
}

const first: AccountSlot = {
	name: "default",
	access: "first-access",
	refresh: "first-refresh",
	expires: Date.now() + 3_600_000,
	source: "login",
};
// A later login: its token expires after the stored one, as a real sign-in does.
const second = { access: "second-access", refresh: "second-refresh", expires: first.expires + 60_000 };
const stored: AnthropicSubscriptionCredential = { ...emptyCredential(), accounts: [first] };

const loginSecond = (callbacks: Parameters<ReturnType<typeof createOAuthConfig>["login"]>[0]) =>
	createOAuthConfig({ readCurrent: async () => stored, loginFlow: fakeFlow(second) }).login(callbacks);

describe("a second Claude account is added, never written over a working one (senpi#3619)", () => {
	it("Enter at the name prompt adds account-2 and leaves the first account as it was", async () => {
		const result = await loginSecond({ onPrompt: async () => "" });
		const persisted = appendLoginSlot(stored, result as AnthropicSubscriptionCredential);
		const slots = listAccounts(persisted as never);

		expect(slots.map((slot) => slot.name)).toEqual(["default", "account-2"]);
		expect(slots[0]).toEqual(first);
		expect(slots[1]?.access).toBe("second-access");
	});

	it("a login with no name prompt (RPC, desktop) adds account-2 too", async () => {
		const result = await loginSecond({});
		const slots = listAccounts(appendLoginSlot(stored, result as AnthropicSubscriptionCredential) as never);

		expect(slots.map((slot) => slot.name)).toEqual(["default", "account-2"]);
		expect(slots[0]).toEqual(first);
	});

	it("the prompt offers account-2 as its default, so Enter means add", async () => {
		const prompts: { message: string; placeholder?: string }[] = [];
		await loginSecond({
			onPrompt: async (prompt) => {
				prompts.push(prompt);
				return "";
			},
		});

		expect(prompts.at(-1)?.placeholder).toBe("account-2");
	});

	it("typing the existing name still refreshes that account in place", async () => {
		const result = await loginSecond({ onPrompt: async () => "default" });
		const slots = listAccounts(appendLoginSlot(stored, result as AnthropicSubscriptionCredential) as never);

		expect(slots.map((slot) => slot.name)).toEqual(["default"]);
		expect(slots[0]?.access).toBe("second-access");
	});
});
