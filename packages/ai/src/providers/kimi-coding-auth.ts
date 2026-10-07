import {
	chooseKimiCodeLoginEndpoints,
	KIMI_CODE_OAUTH_HOST_ENV,
	KIMI_CODE_REGION_ENV,
	KIMI_OAUTH_HOST_ENV,
	resolveKimiCodeEndpoints,
} from "../auth/oauth/kimi-region.ts";
import type { ApiKeyAuth, AuthContext } from "../auth/types.ts";

const KIMI_API_KEY_ENV = "KIMI_API_KEY";

async function envValue(ctx: AuthContext, name: string, signal: AbortSignal): Promise<string | undefined> {
	const value = await ctx.env(name);
	signal.throwIfAborted();
	return value || undefined;
}

/**
 * Kimi Code api-key auth: the key resolves like `envApiKeyAuth` (stored key,
 * then `KIMI_API_KEY`), and the account's region rides along as credential env
 * so an international key is routed to kimi.ai. No client identity headers:
 * a platform key is not a subscription session (#1504).
 */
export function kimiCodeApiKeyAuth(): ApiKeyAuth {
	return {
		name: "Kimi API key",
		login: async (interaction) => {
			const endpoints = await chooseKimiCodeLoginEndpoints(interaction);
			const key = await interaction.prompt({ type: "secret", message: "Enter Kimi API key" });
			interaction.signal.throwIfAborted();
			return { type: "api_key", key, ...(endpoints.env ? { env: endpoints.env } : {}) };
		},
		resolve: async ({ ctx, credential, signal }) => {
			signal.throwIfAborted();
			const key = credential?.key || (await envValue(ctx, KIMI_API_KEY_ENV, signal));
			if (!key) return undefined;
			const endpoints = resolveKimiCodeEndpoints({
				storedRegion: credential?.env?.[KIMI_CODE_REGION_ENV],
				storedOauthHost: credential?.env?.[KIMI_CODE_OAUTH_HOST_ENV],
				envOauthHost:
					(await envValue(ctx, KIMI_CODE_OAUTH_HOST_ENV, signal)) ??
					(await envValue(ctx, KIMI_OAUTH_HOST_ENV, signal)),
				envRegion: await envValue(ctx, KIMI_CODE_REGION_ENV, signal),
			});
			return {
				auth: { apiKey: key, ...(endpoints.apiBaseUrl ? { baseUrl: endpoints.apiBaseUrl } : {}) },
				...(credential?.env ? { env: credential.env } : {}),
				source: credential?.key ? "stored credential" : KIMI_API_KEY_ENV,
			};
		},
	};
}
