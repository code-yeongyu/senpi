import type { AnthropicSubscriptionTokenInjection } from "./settings.ts";

/** Prompt-cache lifetimes Claude Code accepts for `CLAUDE_CODE_PROMPT_CACHE_TTL`. */
export type PromptCacheTtl = "5m" | "1h";

export const PROMPT_CACHE_TTL_ENV = "CLAUDE_CODE_PROMPT_CACHE_TTL";
/** Claude Code reads this before `CLAUDE_CODE_PROMPT_CACHE_TTL`: when set, every lifetime it writes is 5 minutes. */
export const FORCE_PROMPT_CACHING_5M_ENV = "FORCE_PROMPT_CACHING_5M";

function isTruthy(value: string | undefined): boolean {
	return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parsePromptCacheTtl(value: string | undefined): PromptCacheTtl | undefined {
	return value === "5m" || value === "1h" ? value : undefined;
}

type QueryEnvironment = { env?: Record<string, string | undefined> };

/**
 * Pin Claude Code's prompt-cache lifetime for a one-shot query and return it, so senpi's history breakpoint uses the
 * same lifetime (senpi#2982). The Messages API rejects a 1-hour breakpoint that follows a 5-minute one, and Claude Code
 * otherwise picks its lifetime per request: 1 hour on a subscription within its usage limits, 5 minutes on an API key
 * or after the limits. `FORCE_PROMPT_CACHING_5M` wins, as it does in Claude Code; then an explicit
 * `CLAUDE_CODE_PROMPT_CACHE_TTL`. The managed subscription lanes pin 1 hour,
 * Claude Code's subscription default. The ambient lane can be an API key or a subscription login, so nothing is
 * pinned there and the caller adds no breakpoint.
 */
export function pinOneShotPromptCacheTtl(
	options: QueryEnvironment,
	authLane: AnthropicSubscriptionTokenInjection,
	environment: Readonly<Record<string, string | undefined>>,
): PromptCacheTtl | undefined {
	const forced5m =
		isTruthy(options.env?.[FORCE_PROMPT_CACHING_5M_ENV]) || isTruthy(environment[FORCE_PROMPT_CACHING_5M_ENV]);
	const ttl =
		(forced5m ? "5m" : undefined) ??
		parsePromptCacheTtl(options.env?.[PROMPT_CACHE_TTL_ENV]) ??
		parsePromptCacheTtl(environment[PROMPT_CACHE_TTL_ENV]) ??
		(authLane === "ambient" ? undefined : "1h");
	if (ttl === undefined) return undefined;
	options.env = { ...options.env, [PROMPT_CACHE_TTL_ENV]: ttl };
	return ttl;
}
