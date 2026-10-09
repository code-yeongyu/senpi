import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	baseSelector,
	candidatesAfter,
	type FallbackSelector,
	formatSelector,
	parseFallbackSelector,
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
	/** Providers whose account-wide usage limit or billing failure this session saw: their entries are tried last. */
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
	const isSpent = filters.isProviderSpent;
	if (!isSpent) return scanCandidates(entries, current, filters, () => false);
	let avoided = false;
	const elsewhere = scanCandidates(entries, current, filters, (provider) => {
		const spent = isSpent(provider);
		avoided ||= spent;
		return spent;
	});
	if (elsewhere || !avoided) return elsewhere;
	return scanCandidates(entries, current, filters, () => false);
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
		if (selector.provider === current.model.provider && selector.id === current.model.id) {
			filters.skip(raw, "self");
			continue;
		}
		if (avoidProvider(selector.provider)) {
			filters.skip(raw, "account-limit");
			continue;
		}
		const base = baseSelector(selector);
		if (filters.tried.has(base)) {
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
		if (filters.isCircuitOpen(base)) {
			filters.skip(raw, "circuit-open");
			probe ??= { selector, model, circuitOpen: true };
			continue;
		}
		return { selector, model, circuitOpen: false };
	}
	return probe;
}
