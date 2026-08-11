/**
 * Favorites-aware relevance ranking for model search.
 *
 * Implements .omo/drafts/model-selector-favorites-search-ux-ranking-spec.md:
 * dual query token plans (compound keeps slashes, legacy splits them), a
 * per-token tier ladder over independently matched lowercased fields,
 * worst-tier-first aggregation, and a composite sort key whose canonical
 * provider-path and favorites partitions precede all relevance costs.
 */
import { fuzzyMatch } from "@earendil-works/pi-tui";
import type { ModelSearchItem } from "./model-search.ts";

type FieldName = "id" | "name" | "provider" | "providerId";

const FIELD_NAMES: readonly FieldName[] = ["id", "name", "provider", "providerId"];

/** Exact tier: provider/id < id < provider < name (direct provider/id beats proxy id). */
const EXACT_FIELD_WEIGHTS: Record<FieldName, number> = { providerId: 0, id: 1, provider: 2, name: 3 };
/** Tiers 1-4: id < name < provider < provider/id. */
const RANKED_FIELD_WEIGHTS: Record<FieldName, number> = { id: 0, name: 1, provider: 2, providerId: 3 };

interface FieldMatch {
	tier: number;
	occurrenceStart: number;
	fuzzyScore: number;
}

interface TokenMatch {
	tier: number;
	fieldWeight: number;
	/** fuzzyScore for tier 4, occurrenceStart otherwise. */
	cost: number;
}

interface PlanScore {
	fuzzyCount: number;
	substringCount: number;
	boundarySubstringCount: number;
	wholeTokenCount: number;
	fieldCost: number;
	fuzzyCost: number;
	positionCost: number;
}

export interface RankModelSearchOptions<T> {
	/** When true, favorite matches partition above non-favorites (relevance preserved within each partition). */
	favoritesFirst: boolean;
	/** Callers with a null favorite-ids sentinel return true for all items, making the partition a no-op. */
	isFavorite: (item: T) => boolean;
}

function isAlphanumeric(char: string | undefined): boolean {
	if (!char) {
		return false;
	}
	const code = char.charCodeAt(0);
	return (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
}

/** Best tier for a token inside one field; multiple occurrences pick best tier, then earliest. */
function matchField(token: string, field: string): FieldMatch | null {
	if (field.length === 0) {
		return null;
	}
	if (field === token) {
		return { tier: 0, occurrenceStart: 0, fuzzyScore: 0 };
	}
	let best: FieldMatch | null = null;
	let index = field.indexOf(token);
	while (index !== -1) {
		const leftBoundary = index === 0 || !isAlphanumeric(field[index - 1]);
		const end = index + token.length;
		const rightBoundary = end === field.length || !isAlphanumeric(field[end]);
		const tier = leftBoundary && rightBoundary ? 1 : leftBoundary || rightBoundary ? 2 : 3;
		if (!best || tier < best.tier) {
			best = { tier, occurrenceStart: index, fuzzyScore: 0 };
		}
		index = field.indexOf(token, index + 1);
	}
	if (best) {
		return best;
	}
	const fuzzy = fuzzyMatch(token, field);
	return fuzzy.matches ? { tier: 4, occurrenceStart: 0, fuzzyScore: fuzzy.score } : null;
}

function compareTokenMatches(a: TokenMatch, b: TokenMatch): number {
	return a.tier - b.tier || a.fieldWeight - b.fieldWeight || a.cost - b.cost;
}

/** Token's best field by [tier, fieldWeight, tier === 4 ? fuzzyScore : occurrenceStart]. */
function matchToken(token: string, fields: Record<FieldName, string>): TokenMatch | null {
	let best: TokenMatch | null = null;
	for (const fieldName of FIELD_NAMES) {
		const match = matchField(token, fields[fieldName]);
		if (!match) {
			continue;
		}
		const fieldWeight = match.tier === 0 ? EXACT_FIELD_WEIGHTS[fieldName] : RANKED_FIELD_WEIGHTS[fieldName];
		const candidate: TokenMatch = {
			tier: match.tier,
			fieldWeight,
			cost: match.tier === 4 ? match.fuzzyScore : match.occurrenceStart,
		};
		if (!best || compareTokenMatches(candidate, best) < 0) {
			best = candidate;
		}
	}
	return best;
}

/** Aggregate a plan's token matches worst-tier-first; null if any token matches no field. */
function scorePlan(tokens: string[], fields: Record<FieldName, string>): PlanScore | null {
	const score: PlanScore = {
		fuzzyCount: 0,
		substringCount: 0,
		boundarySubstringCount: 0,
		wholeTokenCount: 0,
		fieldCost: 0,
		fuzzyCost: 0,
		positionCost: 0,
	};
	for (const token of tokens) {
		const match = matchToken(token, fields);
		if (!match) {
			return null;
		}
		if (match.tier === 4) {
			score.fuzzyCount += 1;
			score.fuzzyCost += match.cost;
		} else if (match.tier === 3) {
			score.substringCount += 1;
			score.positionCost += match.cost;
		} else if (match.tier === 2) {
			score.boundarySubstringCount += 1;
			score.positionCost += match.cost;
		} else if (match.tier === 1) {
			score.wholeTokenCount += 1;
			score.positionCost += match.cost;
		} else {
			score.positionCost += match.cost;
		}
		score.fieldCost += match.fieldWeight;
	}
	return score;
}

const PLAN_SCORE_KEYS = [
	"fuzzyCount",
	"substringCount",
	"boundarySubstringCount",
	"wholeTokenCount",
	"fieldCost",
	"fuzzyCost",
	"positionCost",
] as const;

function comparePlanScores(a: PlanScore, b: PlanScore): number {
	for (const key of PLAN_SCORE_KEYS) {
		const diff = a[key] - b[key];
		if (diff !== 0) {
			return diff;
		}
	}
	return 0;
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
	for (let i = 0; i < a.length && i < b.length; i++) {
		const diff = a[i]! - b[i]!;
		if (diff !== 0) {
			return diff;
		}
	}
	return a.length - b.length;
}

function sameTokens(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((token, index) => token === b[index]);
}

/**
 * Filter and rank items by search relevance, optionally partitioning favorites first.
 * Empty trimmed query returns the input unchanged (caller base order is authoritative).
 */
export function rankModelSearchItems<T>(
	items: T[],
	query: string,
	getModel: (item: T) => ModelSearchItem,
	options: RankModelSearchOptions<T>,
): T[] {
	const normalizedQuery = query
		.trim()
		.toLowerCase()
		.replace(/\s*\/\s*/g, "/");
	if (!normalizedQuery) {
		return items;
	}

	const compoundTokens = normalizedQuery.split(/\s+/).filter((token) => token.length > 0);
	const legacyTokens = normalizedQuery.split(/[\s/]+/).filter((token) => token.length > 0);
	const plans = sameTokens(compoundTokens, legacyTokens) ? [compoundTokens] : [compoundTokens, legacyTokens];

	const ranked: { item: T; key: number[] }[] = [];
	for (let index = 0; index < items.length; index++) {
		const item = items[index]!;
		const model = getModel(item);
		const id = model.id.toLowerCase();
		const provider = model.provider.toLowerCase();
		const fields: Record<FieldName, string> = {
			id,
			name: (model.name ?? "").toLowerCase(),
			provider,
			providerId: `${provider}/${id}`,
		};
		let bestPlan: PlanScore | null = null;
		for (const plan of plans) {
			const score = scorePlan(plan, fields);
			if (score && (!bestPlan || comparePlanScores(score, bestPlan) < 0)) {
				bestPlan = score;
			}
		}
		if (!bestPlan) {
			continue;
		}
		const canonicalProviderPathMiss = normalizedQuery === fields.providerId ? 0 : 1;
		const favoritePartition = options.favoritesFirst ? (options.isFavorite(item) ? 0 : 1) : 0;
		ranked.push({
			item,
			key: [
				canonicalProviderPathMiss,
				favoritePartition,
				bestPlan.fuzzyCount,
				bestPlan.substringCount,
				bestPlan.boundarySubstringCount,
				bestPlan.wholeTokenCount,
				bestPlan.fieldCost,
				bestPlan.fuzzyCost,
				bestPlan.positionCost,
				id.length,
				index,
			],
		});
	}
	ranked.sort((a, b) => compareKeys(a.key, b.key));
	return ranked.map((entry) => entry.item);
}
