import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import {
	baseSelector,
	candidatesAfter,
	type FallbackSelector,
	formatSelector,
	parseFallbackSelector,
	rungSelector,
} from "./chains.ts";

export interface CandidateRegistry {
	find(provider: string, id: string): Model<Api> | undefined;
	getAll(): Model<Api>[];
}

export interface CandidateFilters {
	registry: CandidateRegistry;
	tried: ReadonlySet<string>;
	isSuppressed(base: string): boolean;
	isAuthAvailable(provider: string): boolean;
	isCircuitOpen(base: string): boolean;
	/** A model whose every rung is out for this walk (a network blip on it, senpi#3344). */
	isModelSkipped?(base: string): boolean;
	/** Providers whose account-wide usage limit or billing failure this session saw: their entries are skipped. */
	isProviderSpent?(provider: string): boolean;
	skip(candidate: string, skipReason: string): void;
}

export interface UsableCandidate {
	selector: FallbackSelector;
	model: Model<Api>;
	/** True only when every usable entry is circuit-open: the chain then probes instead of refusing. */
	circuitOpen: boolean;
}

export function firstUsableCandidate(
	entries: readonly string[],
	current: { model: Model<Api>; thinkingLevel?: ThinkingLevel },
	filters: CandidateFilters,
): UsableCandidate | undefined {
	return scanCandidates(entries, current, filters, (provider) => filters.isProviderSpent?.(provider) ?? false);
}

/**
 * Whether an entry names the rung already in flight: the same model, and either
 * no explicit level (it inherits the running one) or the running level itself.
 * The same model at another explicit level is a rung of its own and stays a
 * candidate - that is how a chain retries one model with thinking turned off.
 */
function isCurrentRung(
	selector: Pick<FallbackSelector, "provider" | "id" | "thinkingLevel">,
	current: { model: Model<Api>; thinkingLevel?: ThinkingLevel },
): boolean {
	if (selector.provider !== current.model.provider || selector.id !== current.model.id) return false;
	return selector.thinkingLevel === undefined || selector.thinkingLevel === current.thinkingLevel;
}

function scanCandidates(
	entries: readonly string[],
	current: { model: Model<Api>; thinkingLevel?: ThinkingLevel },
	filters: CandidateFilters,
	avoidProvider: (provider: string) => boolean,
): UsableCandidate | undefined {
	let probe: UsableCandidate | undefined;
	for (const raw of candidatesAfter(entries, formatSelector(current.model, current.thinkingLevel))) {
		const selector = parseFallbackSelector(raw, filters.registry);
		if (!selector) {
			filters.skip(raw, "unknown");
			continue;
		}
		if (isCurrentRung(selector, current)) {
			filters.skip(raw, "self");
			continue;
		}
		if (avoidProvider(selector.provider)) {
			filters.skip(raw, "account-limit");
			continue;
		}
		const base = baseSelector(selector);
		if (filters.isModelSkipped?.(base)) {
			filters.skip(raw, "network-blip");
			continue;
		}
		if (filters.tried.has(rungSelector(selector))) {
			filters.skip(raw, "tried");
			continue;
		}
		if (filters.isSuppressed(base)) {
			filters.skip(raw, "suppressed");
			continue;
		}
		if (!filters.isAuthAvailable(selector.provider)) {
			filters.skip(raw, "unauthenticated");
			continue;
		}
		const model = filters.registry.find(selector.provider, selector.id);
		if (!model) {
			filters.skip(raw, "unknown");
			continue;
		}
		// A hard-error park is keyed by the level the rung ran at, so check the level this entry
		// would run at: its own, or the inherited one, clamped like the switch does (senpi#3311).
		const level = clampThinkingLevel(model, selector.thinkingLevel ?? current.thinkingLevel ?? "off");
		// An explicit level that clamps to the running one is the rung in flight (senpi#3321).
		if (base === formatSelector(current.model) && level === (current.thinkingLevel ?? "off")) {
			filters.skip(raw, "self");
			continue;
		}
		if (filters.isSuppressed(rungSelector({ ...selector, thinkingLevel: level }))) {
			filters.skip(raw, "suppressed");
			continue;
		}
		if (filters.isCircuitOpen(base)) {
			filters.skip(raw, "circuit-open");
			probe ??= { selector, model, circuitOpen: true };
			continue;
		}
		return { selector, model, circuitOpen: false };
	}
	return probe;
}
