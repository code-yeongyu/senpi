import { normalizeProviderId } from "../legacy-provider-ids.ts";
import type { Api, CacheRetention, Model, OpenAIResponsesCompat } from "../types.ts";

/**
 * Which OpenAI prompt-cache contract a Responses-lane request runs under
 * (https://developers.openai.com/api/docs/guides/prompt-caching, "Cache lifetime"):
 *
 * - `chatgpt-subscription`: signed-in ChatGPT usage (Codex backend or Sign in with ChatGPT). OpenAI keeps this
 *   cache with no expiry (senpi#6290); no API doc publishes a lifetime, so it carries no TTL to schedule around.
 * - `api-long`: GPT-5.6+ on a request that sends `prompt_cache_options.ttl: "12h"` (12-hour minimum lifetime).
 * - `api-extended`: GPT-5.6+ at the default `"30m"` minimum lifetime.
 * - `api-short`: earlier models, and gateways that proxy GPT-5.6+ ids without OpenAI's contract.
 */
export type OpenAIPromptCacheLane = "chatgpt-subscription" | "api-long" | "api-extended" | "api-short";

/** GPT-5.6 and later (`gpt-5.6-*`, `gpt-5.10`, `gpt-6-*`, `gpt-7`, ...). */
const OPENAI_EXTENDED_CACHE_MODEL_ID = /^gpt-(?:5\.(?:[6-9]|\d{2,})|(?:[6-9]|\d{2,})(?:\.\d+)?)(?:-|$)/i;

const CHATGPT_SUBSCRIPTION_PROVIDER = "chatgpt-subscription";

/** Hosts that serve signed-in ChatGPT usage: the Codex backend, and the API host Sign in with ChatGPT routes to. */
const CHATGPT_SUBSCRIPTION_HOSTS: ReadonlySet<string> = new Set(["chatgpt.com", "api.openai.com"]);

function hostnameOf(baseUrl: string): string | undefined {
	try {
		return new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

function responsesCompat(model: Model<Api>): OpenAIResponsesCompat | undefined {
	return model.compat as OpenAIResponsesCompat | undefined;
}

function isChatGptSubscription(model: Model<Api>): boolean {
	if (model.api !== "openai-codex-responses" && model.api !== "openai-responses") return false;
	const host = hostnameOf(model.baseUrl);
	if (host === undefined || !CHATGPT_SUBSCRIPTION_HOSTS.has(host)) return false;
	return (
		normalizeProviderId(model.provider) === CHATGPT_SUBSCRIPTION_PROVIDER || responsesCompat(model)?.siwc === true
	);
}

/**
 * The OpenAI-operated Responses lanes serving a GPT-5.6+ model, where OpenAI documents a cache lifetime of at
 * least 30 minutes. Gateways that merely proxy the same model ids keep the short lifetime: their routing does
 * not carry that contract.
 */
function hasExtendedPromptCache(model: Model<Api>): boolean {
	if (model.api === "openai-responses") {
		if (responsesCompat(model)?.supportsExplicitPromptCacheMode === true) return true;
		if (model.provider !== "openai" && hostnameOf(model.baseUrl) !== "api.openai.com") return false;
	}
	return OPENAI_EXTENDED_CACHE_MODEL_ID.test(model.id);
}

/**
 * Mirrors the `openai-responses` adapter's `getPromptCacheOptions()`: `"12h"` is sent only on `long` retention,
 * to a model that accepts `prompt_cache_options` outside Sign in with ChatGPT, unless compat opts out of long
 * retention. Azure and Codex-protocol requests carry no `prompt_cache_options`.
 */
function sendsTwelveHourTtl(model: Model<Api>, retention: CacheRetention): boolean {
	const compat = responsesCompat(model);
	return (
		retention === "long" &&
		model.api === "openai-responses" &&
		compat?.siwc !== true &&
		compat?.supportsExplicitPromptCacheMode === true &&
		compat.supportsLongCacheRetention !== false
	);
}

export function classifyOpenAIPromptCacheLane(model: Model<Api>, retention: CacheRetention): OpenAIPromptCacheLane {
	if (isChatGptSubscription(model)) return "chatgpt-subscription";
	if (sendsTwelveHourTtl(model, retention)) return "api-long";
	return hasExtendedPromptCache(model) ? "api-extended" : "api-short";
}
