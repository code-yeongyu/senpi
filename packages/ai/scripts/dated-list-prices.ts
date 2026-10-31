import type { Api, Model, ModelCost } from "../src/types.ts";

// The 2026-10-13 Argon model's introductory list price ($2 in / $10 out / $0.10 cache read per 1M) ends
// 2026-11-30; from 2026-12-01 00:00 US Pacific the provider bills $4 / $20 / $0.20 on its public API and
// its cloud endpoint alike (https://ai.google.dev/gemini-api/docs/pricing,
// https://cloud.google.com/vertex-ai/generative-ai/pricing). Both cards are pinned over whatever models.dev
// reports, so the switch needs no regeneration and a row built after upstream catches up still bills earlier
// requests at the introductory rate (senpi#3378).
const ARGON_LIST_PRICE: ModelCost = {
	input: 2,
	output: 10,
	cacheRead: 0.1,
	cacheWrite: 0,
	effectiveRates: [{ effectiveFrom: "2026-12-01T08:00:00Z", input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 }],
};

const DATED_LIST_PRICES: Record<string, Record<string, ModelCost>> = {
	google: { "gemini-4-argon": ARGON_LIST_PRICE },
	"google-vertex": { "gemini-4-argon": ARGON_LIST_PRICE },
};

export function applyDatedListPrice(model: Model<Api>): void {
	const pinned = DATED_LIST_PRICES[model.provider]?.[model.id];
	if (!pinned) return;
	model.cost = structuredClone(pinned);
}
