/**
 * Devin's credential-free model seed.
 *
 * Cascade's real catalog is credential-scoped (see api/devin-agent/discovery.ts),
 * so the bundle ships the lanes the released Devin CLI names and lets runtime
 * discovery replace them once an account is signed in. The bare `swe-2` uid is
 * deliberately absent: Cascade only serves SWE-2 through its effort lanes and
 * answers the bare uid with permission_denied.
 */

import type { Model } from "../types.ts";
import { DEVIN_DEFAULT_BASE_URL } from "../api/devin-agent/paths.ts";

const SWE_2_CONTEXT_WINDOW = 262_000;
const SWE_1_6_CONTEXT_WINDOW = 200_000;
const SWE_MAX_TOKENS = 64_000;

function devinModel(id: string, name: string, contextWindow: number): Model<"devin-agent"> {
	return {
		id,
		name,
		api: "devin-agent",
		provider: "devin",
		baseUrl: DEVIN_DEFAULT_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: SWE_MAX_TOKENS,
		compat: { supportsParallelToolCalls: true },
	};
}

export const DEVIN_MODELS: Model<"devin-agent">[] = [
	devinModel("swe-2-high", "SWE-2 (high)", SWE_2_CONTEXT_WINDOW),
	devinModel("swe-2-max", "SWE-2 (max)", SWE_2_CONTEXT_WINDOW),
	devinModel("swe-2-low", "SWE-2 (low)", SWE_2_CONTEXT_WINDOW),
	devinModel("swe-2-high-lite", "SWE-2 (high, lite)", SWE_2_CONTEXT_WINDOW),
	devinModel("swe-1-6", "SWE-1.6", SWE_1_6_CONTEXT_WINDOW),
	devinModel("swe-1-6-fast", "SWE-1.6 Fast", SWE_1_6_CONTEXT_WINDOW),
];
