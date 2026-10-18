import type { OAuthAuth, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { listAccounts } from "../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { createOAuthConfig } from "../src/core/extensions/builtin/anthropic-subscription/oauth-login.ts";

const fresh = { access: "a1", refresh: "r1", expires: Date.now() + 60_000 };

// Mirrors the upstream Anthropic OAuth flow: the login begins with a mandatory
// select prompt ("browser" default vs "copy_code"). The fork adapter must relay
// it, never returning "" and tripping the "Unknown Anthropic login method" throw.
function selectorFlow(onResolved: (method: string) => void): OAuthAuth {
	return {
		name: "selector",
		async login(interaction: ProviderAuthInteraction) {
			const method = await interaction.prompt({
				type: "select",
				message: "Select Anthropic login method:",
				options: [
					{ id: "browser", label: "Browser login (default)" },
					{ id: "copy_code", label: "Copy code login (headless)" },
				],
			});
			if (method !== "browser") {
				throw new Error(`Unknown Anthropic login method: ${method}`);
			}
			onResolved(method);
			return { type: "oauth", ...fresh };
		},
		async refresh(current) {
			return current;
		},
		async toAuth(current) {
			return { apiKey: current.access };
		},
	};
}

describe("claude-sdk-oauth login relays the method selector", () => {
	it("relays a mandatory select prompt through the adapter and completes a browser login", async () => {
		let resolved = "";
		const config = createOAuthConfig({
			readCurrent: async () => undefined,
			loginFlow: selectorFlow((m) => (resolved = m)),
		});
		const credential = await config.login({});
		// Before the relay fix the adapter answered "" and the flow threw on it.
		expect(resolved).toBe("browser");
		const slots = listAccounts(credential as never);
		expect(slots.map((slot) => slot.name)).toEqual(["default"]);
	});
});
