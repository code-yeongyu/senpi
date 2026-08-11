import type { Api, Model } from "@earendil-works/pi-ai";
import { isValidThinkingLevel } from "../../cli/args.ts";

/**
 * Providers that never receive a bare selector. OpenRouter re-publishes other
 * vendors' catalogs under namespaced ids, so family expansion would silently
 * route a shipped default through a third-party reseller the user never chose.
 * An explicit `openrouter/...` selector the user wrote is unaffected.
 */
const BARE_EXPANSION_DENYLIST: ReadonlySet<string> = new Set(["openrouter", "openrouter-images"]);

/**
 * Deterministic tie-break inside one auth tier. Earlier wins. Providers absent
 * from the table sort after every listed one, alphabetically.
 */
const PROVIDER_PRECEDENCE: readonly string[] = ["claude-sdk-oauth", "anthropic", "kimi-coding"];

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
function withoutNamespace(modelId: string): string {
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
 * Ranks one model per eligible provider: OAuth-credential providers first (a
 * logged-in subscription is the account the user actually wants used), then the
 * fixed precedence table, then alphabetically.
 */
export function rankFamilyModels(
	models: readonly Model<Api>[],
	family: string,
	tiers: FallbackAuthTiers,
	options: { limit?: number } = {},
): Model<Api>[] {
	const byProvider = new Map<string, Model<Api>[]>();
	for (const model of models) {
		if (BARE_EXPANSION_DENYLIST.has(model.provider.toLowerCase())) continue;
		if (!matchesFamily(model, family)) continue;
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
