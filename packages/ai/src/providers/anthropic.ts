import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import type { AnthropicOptions } from "../api/anthropic-messages.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import {
	ANTHROPIC_API_KEY_ENV,
	ANTHROPIC_AUTH_TOKEN_ENV,
	ANTHROPIC_FEDERATION_RULE_ID_ENV,
	ANTHROPIC_IDENTITY_TOKEN_FILE_ENV,
	ANTHROPIC_OAUTH_TOKEN_ENV,
	ANTHROPIC_ORGANIZATION_ID_ENV,
	ANTHROPIC_SERVICE_ACCOUNT_ID_ENV,
	ANTHROPIC_WORKSPACE_ID_ENV,
} from "../env-api-keys.ts";
import { createProvider, type Provider } from "../models.ts";
import type { ProviderEnv, SimpleStreamOptions, StreamFunction } from "../types.ts";
import { ANTHROPIC_MODELS } from "./anthropic.models.ts";

const anthropicStreams = anthropicMessagesApi();
export const streamAnthropic: StreamFunction<"anthropic-messages", AnthropicOptions> = anthropicStreams.stream;
export const streamSimpleAnthropic: StreamFunction<"anthropic-messages", SimpleStreamOptions> =
	anthropicStreams.streamSimple;

function anthropicApiKeyAuth(): ApiKeyAuth {
	return {
		name: "Anthropic API key",
		login: async (interaction) => {
			interaction.signal.throwIfAborted();
			const key = await interaction.prompt({ type: "secret", message: "Enter Anthropic API key" });
			interaction.signal.throwIfAborted();
			return { type: "api_key", key };
		},
		resolve: async ({ ctx, credential, signal }) => {
			signal.throwIfAborted();
			if (credential?.key) {
				return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
			}

			const authToken = await ctx.env(ANTHROPIC_AUTH_TOKEN_ENV);
			signal.throwIfAborted();
			if (authToken) {
				return {
					auth: { headers: { Authorization: `Bearer ${authToken}` } },
					source: ANTHROPIC_AUTH_TOKEN_ENV,
				};
			}

			for (const envVar of [ANTHROPIC_OAUTH_TOKEN_ENV, ANTHROPIC_API_KEY_ENV]) {
				const apiKey = await ctx.env(envVar);
				signal.throwIfAborted();
				if (apiKey) return { auth: { apiKey }, source: envVar };
			}

			// Workload identity federation: the Anthropic SDK exchanges the identity
			// token for a short-lived access token and refreshes it itself. Last in
			// line so keys and ANTHROPIC_AUTH_TOKEN keep winning, as in the SDK. The
			// ids are provider config rather than auth, so they travel in `env`.
			const federation: ProviderEnv = {};
			for (const envVar of [
				ANTHROPIC_FEDERATION_RULE_ID_ENV,
				ANTHROPIC_ORGANIZATION_ID_ENV,
				ANTHROPIC_IDENTITY_TOKEN_FILE_ENV,
			]) {
				const value = await ctx.env(envVar);
				signal.throwIfAborted();
				if (!value) return undefined;
				federation[envVar] = value;
			}
			for (const envVar of [ANTHROPIC_SERVICE_ACCOUNT_ID_ENV, ANTHROPIC_WORKSPACE_ID_ENV]) {
				const value = await ctx.env(envVar);
				signal.throwIfAborted();
				if (value) federation[envVar] = value;
			}
			return { auth: {}, env: federation, source: "workload identity federation" };
		},
	};
}

export function anthropicProvider(): Provider<"anthropic-messages"> {
	return createProvider({
		id: "anthropic",
		name: "Anthropic",
		baseUrl: "https://api.anthropic.com",
		// No Claude subscription OAuth here (senpi#3259): Anthropic bills a subscription token sent
		// straight to the Messages API as a third-party app (extra usage). Subscriptions log in through
		// the Agent SDK lane (`anthropic-subscription`), which signs in through the bundled Claude Code CLI;
		// senpi ships no Anthropic OAuth flow of its own (senpi#4436).
		auth: {
			apiKey: anthropicApiKeyAuth(),
		},
		models: Object.values(ANTHROPIC_MODELS),
		api: anthropicMessagesApi(),
	});
}
