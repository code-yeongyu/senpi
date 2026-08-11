import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { isValidThinkingLevel } from "../../cli/args.ts";
import { findExactModelReferenceMatch, parseModelPattern } from "../model-resolver.ts";
import { type FallbackAuthTiers, MAX_PROVIDERS_PER_FAMILY, parseBareSelector, rankFamilyModels } from "./expansion.ts";

export interface FallbackSelector {
	raw: string;
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

export type FallbackChains = Readonly<Record<string, readonly string[]>>;

export type FallbackModelLookup =
	| readonly Model<Api>[]
	| {
			getAll(): Model<Api>[];
			isUsingOAuth?(model: Model<Api>): boolean;
			hasConfiguredAuth?(model: Model<Api>): boolean;
	  };

function availableModels(lookup: FallbackModelLookup): Model<Api>[] {
	return "getAll" in lookup ? lookup.getAll() : [...lookup];
}

/**
 * Auth tier is optional so array lookups and older callers keep working; without
 * it every provider lands in the non-OAuth tier and the precedence table decides.
 */
function authTiers(lookup: FallbackModelLookup): FallbackAuthTiers {
	if (Array.isArray(lookup)) return { isUsingOAuth: () => false };
	const registry = lookup as {
		isUsingOAuth?(model: Model<Api>): boolean;
		hasConfiguredAuth?(model: Model<Api>): boolean;
	};
	return {
		isUsingOAuth: (model) => registry.isUsingOAuth?.(model) === true,
		hasConfiguredAuth:
			typeof registry.hasConfiguredAuth === "function"
				? (model) => registry.hasConfiguredAuth?.(model) === true
				: undefined,
	};
}

/** An empty entry list is the documented opt-out; it survives as a tombstone. */
export function isChainTombstone(entries: readonly string[] | undefined): boolean {
	return Array.isArray(entries) && entries.length === 0;
}

function selectorReference(raw: string): { reference: string; thinkingLevel?: ThinkingLevel } | undefined {
	const trimmed = raw.trim();
	if (!trimmed.includes("/") || trimmed.includes("*")) return undefined;

	const lastColon = trimmed.lastIndexOf(":");
	if (lastColon === -1) return { reference: trimmed };

	const prefix = trimmed.slice(0, lastColon);
	const suffix = trimmed.slice(lastColon + 1).toLowerCase();
	if (!isValidThinkingLevel(suffix)) return { reference: trimmed };
	return { reference: prefix, thinkingLevel: suffix };
}

/**
 * Resolves only complete provider/model selectors. The full input is resolved first
 * so colons belonging to a model id remain part of that id; aliases then resolve
 * against the model-id portion while retaining the explicitly selected provider.
 */
export function parseFallbackSelector(raw: string, lookup: FallbackModelLookup): FallbackSelector | undefined {
	const models = availableModels(lookup);
	const trimmed = raw.trim();
	const parsedReference = selectorReference(trimmed);
	if (!parsedReference) return undefined;

	const fullMatch = findExactModelReferenceMatch(trimmed, models);
	if (fullMatch) {
		return { raw: trimmed, provider: fullMatch.provider, id: fullMatch.id };
	}

	const slashIndex = parsedReference.reference.indexOf("/");
	const provider = parsedReference.reference.slice(0, slashIndex).trim();
	const modelPattern = parsedReference.reference.slice(slashIndex + 1).trim();
	if (!provider || !modelPattern) return undefined;

	// The provider is explicit, so resolve the id pattern inside that provider only.
	// A global lookup lets foreign ids containing the pattern (e.g. Bedrock's
	// "us.anthropic.claude-opus-5") win over the requested provider's exact id.
	const providerModels = models.filter((model) => model.provider.toLowerCase() === provider.toLowerCase());
	const parsed = parseModelPattern(
		parsedReference.thinkingLevel ? `${modelPattern}:${parsedReference.thinkingLevel}` : modelPattern,
		providerModels,
		{ allowInvalidThinkingLevelFallback: false },
	);
	if (!parsed.model || parsed.warning) return undefined;
	if (parsedReference.thinkingLevel && !parsed.thinkingLevel) return undefined;

	return {
		raw: trimmed,
		provider: parsed.model.provider,
		id: parsed.model.id,
		thinkingLevel: parsed.thinkingLevel,
	};
}

export function formatSelector(model: Model<Api>, thinkingLevel?: ThinkingLevel): string {
	const base = `${model.provider}/${model.id}`;
	return thinkingLevel ? `${base}:${thinkingLevel}` : base;
}

export function baseSelector(selector: Pick<FallbackSelector, "provider" | "id">): string {
	return `${selector.provider}/${selector.id}`;
}

/**
 * Converts validated configuration to canonical selector strings for runtime lookup.
 *
 * A bare key (no provider prefix) is a model-family policy: it expands to one
 * canonical key per provider serving that family, so a chain shipped for
 * `claude-fable-5` applies no matter which provider the user attached it through.
 * Provider-qualified keys and entries keep exact semantics, and an explicit key
 * always overrides the expansion it collides with.
 */
export function canonicalizeFallbackChains(chains: FallbackChains, lookup: FallbackModelLookup): FallbackChains {
	const models = availableModels(lookup);
	const tiers = authTiers(lookup);
	const canonical: Record<string, readonly string[]> = {};
	const explicitKeys = new Set<string>();
	const tombstones = new Set<string>();

	const expandEntries = (entries: readonly string[], keySelector: string): string[] =>
		entries.flatMap((entry) => {
			const bare = parseBareSelector(entry);
			if (bare) {
				return rankFamilyModels(models, bare.family, tiers, { limit: MAX_PROVIDERS_PER_FAMILY })
					.map((model) =>
						bare.thinkingLevel ? `${formatSelector(model)}:${bare.thinkingLevel}` : formatSelector(model),
					)
					.filter((selector) => normalizedBase(selector) !== normalizedBase(keySelector));
			}
			const parsedEntry = parseFallbackSelector(entry, models);
			return parsedEntry ? [formatParsedSelector(parsedEntry)] : [];
		});

	// Bare keys expand first so a same-named explicit key can overwrite them.
	for (const [key, entries] of Object.entries(chains)) {
		const bareKey = parseBareSelector(key);
		if (!bareKey || !Array.isArray(entries)) continue;
		if (isChainTombstone(entries)) {
			for (const model of rankFamilyModels(models, bareKey.family, tiers)) {
				tombstones.add(formatSelector(model).toLowerCase());
			}
			continue;
		}
		for (const model of rankFamilyModels(models, bareKey.family, tiers)) {
			const keySelector = bareKey.thinkingLevel
				? `${formatSelector(model)}:${bareKey.thinkingLevel}`
				: formatSelector(model);
			const canonicalEntries = expandEntries(entries, keySelector);
			if (canonicalEntries.length > 0) canonical[keySelector] = canonicalEntries;
		}
	}

	for (const [key, entries] of Object.entries(chains)) {
		if (parseBareSelector(key)) continue;
		const parsedKey = parseFallbackSelector(key, models);
		if (!parsedKey || !Array.isArray(entries)) continue;
		const keySelector = formatParsedSelector(parsedKey);
		if (isChainTombstone(entries)) {
			tombstones.add(normalizedBase(keySelector));
			continue;
		}
		explicitKeys.add(keySelector.toLowerCase());
		const canonicalEntries = expandEntries(entries, keySelector);
		if (canonicalEntries.length > 0) canonical[keySelector] = canonicalEntries;
	}

	for (const key of Object.keys(canonical)) {
		if (explicitKeys.has(key.toLowerCase())) continue;
		if (tombstones.has(normalizedBase(key))) delete canonical[key];
	}

	return canonical;
}

export function resolveChainKey(
	currentModel: Model<Api>,
	currentThinking: ThinkingLevel | undefined,
	chains: FallbackChains,
): string | undefined {
	const base = formatSelector(currentModel);
	const exact = currentThinking ? `${base}:${currentThinking}` : base;
	if (Object.hasOwn(chains, exact)) return exact;
	return Object.hasOwn(chains, base) ? base : undefined;
}

function formatParsedSelector(selector: FallbackSelector): string {
	const base = baseSelector(selector);
	return selector.thinkingLevel ? `${base}:${selector.thinkingLevel}` : base;
}

function normalizedBase(selector: FallbackSelector | string): string {
	if (typeof selector !== "string") return baseSelector(selector).toLowerCase();

	const normalized = selector.trim().toLowerCase();
	const lastColon = normalized.lastIndexOf(":");
	if (lastColon === -1 || !isValidThinkingLevel(normalized.slice(lastColon + 1))) return normalized;
	return normalized.slice(0, lastColon);
}

function normalizedExact(selector: FallbackSelector | string): string {
	return typeof selector === "string" ? selector.trim().toLowerCase() : formatParsedSelector(selector).toLowerCase();
}

/**
 * Returns entries after the current fallback. A primary or unknown selector starts
 * from the beginning, which also makes re-entry after stale runtime state safe.
 */
export function candidatesAfter(
	chainEntries: readonly string[],
	currentSelector: FallbackSelector | string,
): readonly string[] {
	const exact = normalizedExact(currentSelector);
	const exactIndex = chainEntries.findIndex((entry) => entry.toLowerCase() === exact);
	if (exactIndex !== -1) return chainEntries.slice(exactIndex + 1);

	const base = normalizedBase(currentSelector);
	const baseIndex = chainEntries.findIndex((entry) => normalizedBase(entry) === base);
	return baseIndex === -1 ? chainEntries : chainEntries.slice(baseIndex + 1);
}
