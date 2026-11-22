import type { ModelCost, ModelCostCard } from "./types.ts";

/** The card in force at `atMs`: the latest dated card that has started, else the base card. */
export function costCardAt(cost: ModelCost, atMs: number): ModelCostCard {
	let card: ModelCostCard = cost;
	let startedAt = Number.NEGATIVE_INFINITY;
	for (const rate of cost.effectiveRates ?? []) {
		const from = Date.parse(rate.effectiveFrom);
		if (from <= atMs && from > startedAt) {
			card = rate;
			startedAt = from;
		}
	}
	return card;
}
