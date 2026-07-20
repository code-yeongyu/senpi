import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { isValidThinkingLevel } from "../../cli/args.ts";
import { findExactModelReferenceMatch, parseModelPattern } from "../model-resolver.ts";

export interface FallbackSelector {
	raw: string;
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

export type FallbackChains = Readonly<Record<string, readonly string[]>>;

export type FallbackModelLookup = readonly Model<Api>[] | { getAll(): Model<Api>[] };

function availableModels(lookup: FallbackModelLookup): Model<Api>[] {
	return "getAll" in lookup ? lookup.getAll() : [...lookup];
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

	const parsed = parseModelPattern(
		parsedReference.thinkingLevel ? `${modelPattern}:${parsedReference.thinkingLevel}` : modelPattern,
		models,
		{ allowInvalidThinkingLevelFallback: false },
	);
	if (!parsed.model || parsed.warning || parsed.model.provider.toLowerCase() !== provider.toLowerCase())
		return undefined;
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

/** Converts validated configuration to canonical selector strings for runtime lookup. */
export function canonicalizeFallbackChains(chains: FallbackChains, lookup: FallbackModelLookup): FallbackChains {
	const canonical: Record<string, readonly string[]> = {};

	for (const [key, entries] of Object.entries(chains)) {
		const parsedKey = parseFallbackSelector(key, lookup);
		if (!parsedKey || !Array.isArray(entries)) continue;

		const canonicalEntries = entries.flatMap((entry) => {
			const parsedEntry = parseFallbackSelector(entry, lookup);
			return parsedEntry ? [formatParsedSelector(parsedEntry)] : [];
		});
		canonical[formatParsedSelector(parsedKey)] = canonicalEntries;
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
