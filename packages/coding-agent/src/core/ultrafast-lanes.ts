import type { ServiceTier } from "./extensions/types.ts";

/**
 * Providers that receive `service_tier: "ultrafast"`: OpenAI's own API and the ChatGPT
 * subscription backend. Gateways and other providers serving an OpenAI model on the Responses
 * API never get it (codex only sends a tier the model's backend catalog lists, and oh-my-pi
 * sends Ultrafast only to first-party OpenAI and Codex models).
 */
const ULTRAFAST_PROVIDERS: ReadonlySet<string> = new Set(["openai", "chatgpt-subscription"]);

const ULTRAFAST_DOCUMENTED_MODEL_IDS: ReadonlySet<string> = new Set(["gpt-6-astra", "gpt-6.1-sol"]);

export function serviceTierForProvider(
	provider: string | undefined,
	serviceTier: ServiceTier | undefined,
): ServiceTier | undefined {
	if (serviceTier !== "ultrafast") return serviceTier;
	return provider !== undefined && ULTRAFAST_PROVIDERS.has(provider) ? serviceTier : undefined;
}

/** A warning, never a refusal: the parsed Ultrafast selection is kept either way. */
export function ultrafastSelectionWarning(
	model: { readonly provider: string; readonly id: string },
	serviceTier: ServiceTier | undefined,
): string | undefined {
	if (serviceTier !== "ultrafast") return undefined;
	if (!ULTRAFAST_PROVIDERS.has(model.provider)) {
		return `Ultrafast is only sent to OpenAI and ChatGPT Subscription; ${model.provider}/${model.id} runs at its default tier`;
	}
	if (ULTRAFAST_DOCUMENTED_MODEL_IDS.has(model.id)) return undefined;
	return `Ultrafast is documented for GPT-6 Astra and GPT-6.1 Sol; ${model.provider}/${model.id} may reject or ignore it`;
}
