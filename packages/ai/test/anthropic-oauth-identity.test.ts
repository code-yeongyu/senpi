import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicOAuth } from "../src/auth/oauth/anthropic.ts";

// senpi#3928: the authorization-code exchange names the Claude account the tokens
// belong to; the login must keep it so a pool can tell one account from another.
function copyCodeLogin(tokenResponse: Record<string, unknown>) {
	let authUrl = "";
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify(tokenResponse), { headers: { "Content-Type": "application/json" } })),
	);
	return anthropicOAuth.login({
		signal: new AbortController().signal,
		notify: (event) => {
			if (event.type === "auth_url") authUrl = event.url;
		},
		prompt: async (prompt) =>
			prompt.type === "select" ? "copy_code" : `code#${new URL(authUrl).searchParams.get("state")}`,
	});
}

describe("Anthropic OAuth login records the account identity (senpi#3928)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("keeps account uuid + organization uuid as the identity and the email for display", async () => {
		const credential = await copyCodeLogin({
			access_token: "a",
			refresh_token: "r",
			expires_in: 3600,
			account: { uuid: "acct-a", email_address: "a@example.com" },
			organization: { uuid: "org-1" },
		});
		expect(credential.identity).toEqual({ id: "acct-a/org-1", email: "a@example.com" });
	});

	it("records no identity when the exchange names no account", async () => {
		const credential = await copyCodeLogin({ access_token: "a", refresh_token: "r", expires_in: 3600 });
		expect(credential.identity).toBeUndefined();
	});
});
