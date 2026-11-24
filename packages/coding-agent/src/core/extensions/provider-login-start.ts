import type { ProviderConfig, ProviderLoginStartEvent } from "./types.ts";

/**
 * Wraps a registered provider's OAuth login so `provider_login_start` is awaited before the provider's own login
 * code runs. Every login entry point (TUI, RPC, account commands) reaches the registered config, so one wrap at
 * registration covers them all.
 */
export function withProviderLoginStart(
	provider: string,
	config: ProviderConfig,
	emit: (event: ProviderLoginStartEvent) => Promise<void>,
): ProviderConfig {
	const oauth = config.oauth;
	if (!oauth) return config;
	return {
		...config,
		oauth: {
			...oauth,
			login: async (callbacks) => {
				await emit({
					type: "provider_login_start",
					provider,
					signal: callbacks.signal ?? new AbortController().signal,
					progress: (message) => callbacks.onProgress?.(message),
				});
				return oauth.login(callbacks);
			},
		},
	};
}
