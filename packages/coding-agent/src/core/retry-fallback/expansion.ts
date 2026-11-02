import type { Api, Model } from "@earendil-works/pi-ai";
import { isValidThinkingLevel } from "../../cli/args.ts";

/**
 * The only providers a bare selector reaches: each model vendor's own lanes,
 * keyed by the vendor's model-id prefix. A bare id is a vendor policy, so a
 * reseller, gateway, cloud re-host or user-added provider that also publishes
 * the model is reached only through a selector that names it (`provider/id`).
 * Every provider id here exists in the builtin catalog or is registered by a
 * builtin extension (`anthropic-subscription`).
 */
export const FIRST_PARTY_PROVIDERS: readonly { readonly family: RegExp; readonly providers: readonly string[] }[] = [
	{ family: /^claude-/, providers: ["anthropic-subscription", "anthropic"] },
	{ family: /^(?:gpt-|o\d)/, providers: ["chatgpt-subscription", "openai"] },
	{ family: /^gemini-/, providers: ["google", "google-vertex"] },
	{ family: /^(?:kimi-|k\d)/, providers: ["kimi-coding", "moonshotai", "moonshotai-cn"] },
	{ family: /^glm-/, providers: ["zai", "zai-coding-cn"] },
	{ family: /^grok-/, providers: ["xai"] },
	{ family: /^deepseek-/, providers: ["deepseek"] },
	{ family: /^(?:mistral|codestral|devstral|magistral|ministral|pixtral)/, providers: ["mistral"] },
	{ family: /^minimax-/, providers: ["minimax", "minimax-cn"] },
	{
		family: /^mimo-/,
		providers: ["xiaomi", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp", "xiaomi-token-plan-ams"],
	},
	{
		family: /^qwen/,
		providers: ["qwen-token-plan", "qwen-token-plan-individual", "qwen-token-plan-cn", "alibaba-token-plan"],
	},
];

/**
 * Whether a bare selector for `family` may resolve on `provider`. A known vendor
 * resolves only on its first-party providers. An unknown vendor has no
 * first-party lane to prefer, so it stays on `sessionProvider`, the provider the
 * chain key already runs on: `resolveChainKey` only selects a key matching the
 * running model's `provider/id`, so that provider is one the user chose. Bare
 * keys pass no session provider: a key never routes a request, and each
 * expanded key applies only to sessions already on its own provider.
 */
function inBareScope(provider: string, family: string, sessionProvider: string | undefined): boolean {
	const normalized = provider.toLowerCase();
	const vendor = FIRST_PARTY_PROVIDERS.find((entry) => entry.family.test(family));
	if (vendor) return vendor.providers.includes(normalized);
	return sessionProvider === undefined || normalized === sessionProvider.toLowerCase();
}

/**
 * Deterministic tie-break inside one auth tier. Earlier wins. Providers absent
 * from the table sort after every listed one, alphabetically.
 */
const PROVIDER_PRECEDENCE: readonly string[] = ["anthropic-subscription", "anthropic", "kimi-coding"];

export interface BareSelectorParts {
	/** Model id without a provider prefix, e.g. `claude-opus-5`. */
	family: string;
	thinkingLevel?: string;
}

/** Auth-tier probe. Providers holding an OAuth credential outrank API-key ones. */
export type FallbackAuthLookup = (model: Model<Api>) => boolean;

/**
 * Auth tiers for bare expansion. OAuth first (a logged-in subscription is the
 * account the user actually wants used), then any configured credential, then
 * everything else. This ranks rather than filters: the runtime already skips
 * unauthenticated candidates, and dropping them here would erase the chain
 * whenever availability is not yet known.
 */
export interface FallbackAuthTiers {
	isUsingOAuth: FallbackAuthLookup;
	hasConfiguredAuth?: FallbackAuthLookup;
	/**
	 * Deterministic usability gate, distinct from the auth tiers above. Auth
	 * tiers rank; this filters, and only on a definitive `false`: a provider
	 * whose own registration declares every unattended call refused (e.g. an
	 * unacknowledged execution gate) must not consume a bare-expansion slot it
	 * can never serve. Unknown eligibility stays included.
	 */
	isFallbackEligible?: FallbackAuthLookup;
}

function authTier(model: Model<Api>, tiers: FallbackAuthTiers): number {
	if (tiers.isUsingOAuth(model)) return 0;
	if (tiers.hasConfiguredAuth?.(model) === true) return 1;
	return 2;
}

/**
 * How many providers one bare selector may fan out to. A shipped default must
 * stay a short, readable chain: senpi's builtin catalog publishes popular models
 * under a dozen providers, and expanding to all of them turned `/fallback` into
 * an unreadable wall and the policy into "try every gateway that resells this".
 * Two keeps the useful property - a second account for the same model - without
 * the noise.
 */
const MAX_PROVIDERS_PER_FAMILY = 2;

/** A selector is bare when it carries no provider prefix and no wildcard. */
export function parseBareSelector(raw: string): BareSelectorParts | undefined {
	const trimmed = raw.trim();
	if (!trimmed || trimmed.includes("/") || trimmed.includes("*")) return undefined;

	const lastColon = trimmed.lastIndexOf(":");
	if (lastColon === -1) return { family: trimmed.toLowerCase() };

	const suffix = trimmed.slice(lastColon + 1).toLowerCase();
	if (!isValidThinkingLevel(suffix)) return { family: trimmed.toLowerCase() };
	const family = trimmed.slice(0, lastColon).trim().toLowerCase();
	return family ? { family, thinkingLevel: suffix } : undefined;
}

/**
 * Strips a provider-side namespace so Bedrock's `global.anthropic.claude-opus-5`
 * and a gateway's `anthropic/claude-opus-5` both reduce to `claude-opus-5`.
 */
export function withoutNamespace(modelId: string): string {
	const cut = Math.max(modelId.lastIndexOf("."), modelId.lastIndexOf("/"));
	return cut === -1 ? modelId : modelId.slice(cut + 1);
}

/**
 * Conservative family match. A bare id matches its exact model and dash-suffixed
 * variants (`k3` -> `k3-256k`) but never an arbitrary substring, so `claude-fable-5`
 * cannot capture `not-claude-fable-5`.
 */
export function matchesFamily(model: Model<Api>, family: string): boolean {
	const candidates = [model.id.toLowerCase(), withoutNamespace(model.id.toLowerCase())];
	return candidates.some((id) => id === family || id.startsWith(`${family}-`));
}

/** Exact id wins, then the shortest variant, then alphabetical. */
function pickVariant(models: readonly Model<Api>[], family: string): Model<Api> | undefined {
	const ranked = [...models].sort((left, right) => {
		const exact =
			Number(withoutNamespace(right.id.toLowerCase()) === family) -
			Number(withoutNamespace(left.id.toLowerCase()) === family);
		if (exact !== 0) return exact;
		if (left.id.length !== right.id.length) return left.id.length - right.id.length;
		return left.id.localeCompare(right.id);
	});
	return ranked[0];
}

function precedenceIndex(provider: string): number {
	const index = PROVIDER_PRECEDENCE.indexOf(provider.toLowerCase());
	return index === -1 ? PROVIDER_PRECEDENCE.length : index;
}

/**
 * Ranks one model per in-scope, eligible provider: OAuth-credential providers first (a
 * logged-in subscription is the account the user actually wants used), then the
 * fixed precedence table, then alphabetically.
 */
export function rankFamilyModels(
	models: readonly Model<Api>[],
	family: string,
	tiers: FallbackAuthTiers,
	options: { limit?: number; sessionProvider?: string } = {},
): Model<Api>[] {
	const byProvider = new Map<string, Model<Api>[]>();
	for (const model of models) {
		if (!inBareScope(model.provider, family, options.sessionProvider)) continue;
		// Family first: eligibility reads provider settings from disk, and only family members need it.
		if (!matchesFamily(model, family)) continue;
		if (tiers.isFallbackEligible?.(model) === false) continue;
		const bucket = byProvider.get(model.provider);
		if (bucket) bucket.push(model);
		else byProvider.set(model.provider, [model]);
	}

	const picked = [...byProvider.values()].flatMap((variants) => {
		const variant = pickVariant(variants, family);
		return variant ? [variant] : [];
	});

	const ranked = picked.sort((left, right) => {
		const tier = authTier(left, tiers) - authTier(right, tiers);
		if (tier !== 0) return tier;
		const precedence = precedenceIndex(left.provider) - precedenceIndex(right.provider);
		if (precedence !== 0) return precedence;
		return left.provider.localeCompare(right.provider);
	});

	const limit = options.limit ?? ranked.length;
	return ranked.slice(0, limit);
}

export { MAX_PROVIDERS_PER_FAMILY };
