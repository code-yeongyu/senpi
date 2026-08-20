import type { OAuthAuth } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createOAuthConfig } from "../../../src/core/extensions/builtin/claude-sdk-oauth/oauth-login.ts";

describe("LAB-33 Claude OAuth prompt lifecycle", () => {
	it("forwards the provider abort signal to the manual-code prompt", async () => {
		let providerSignal: AbortSignal | undefined;
		let callbackSignal: AbortSignal | undefined;

		const loginFlow: OAuthAuth = {
			name: "LAB-33 fake browser callback",
			login: async (interaction) => {
				const controller = new AbortController();
				providerSignal = controller.signal;
				await interaction.prompt({
					type: "manual_code",
					message: "Paste the authorization code",
					signal: controller.signal,
				});
				controller.abort();
				return {
					type: "oauth",
					access: "new-access",
					refresh: "new-refresh",
					expires: Date.now() + 3_600_000,
				};
			},
			refresh: async (credential) => credential,
			toAuth: async (credential) => ({ apiKey: credential.access }),
		};

		const config = createOAuthConfig({
			readCurrent: async () => undefined,
			loginFlow,
		});

		await config.login({
			onPrompt: async (prompt) => {
				callbackSignal = "signal" in prompt && prompt.signal instanceof AbortSignal ? prompt.signal : undefined;
				return "browser-callback-code";
			},
			onProgress: () => {},
		});

		expect(callbackSignal).toBe(providerSignal);
		expect(callbackSignal?.aborted).toBe(true);
	});
});
