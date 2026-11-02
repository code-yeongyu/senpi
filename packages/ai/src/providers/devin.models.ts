/**
 * Devin's credential-free model seed.
 *
 * Cascade's real catalog is credential-scoped (see api/devin-agent/discovery.ts),
 * so the bundle ships the lanes the released Devin CLI names and lets runtime
 * discovery replace them once an account is signed in. SWE-2 is seeded as
 * exactly the effort lanes Cascade serves - `swe-2-high`, `swe-2-medium`,
 * `swe-2-max`. The bare `swe-2` uid and the `swe-2-low` / `swe-2-high-lite`
 * strings found only inside the Devin CLI binary are deliberately absent:
 * Cascade answers them with permission_denied (#2306).
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
		// Cascade's chat protocol has no request-side thinking field: effort is
		// selected through the lane uid and a generic level is never forwarded.
		// `reasoning: false` hides the dead thinking-level control; streamed
		// thinking output still renders because it is message content, not a
		// capability gate.
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: SWE_MAX_TOKENS,
		compat: { supportsParallelToolCalls: true },
	};
}

export const DEVIN_MODELS: Model<"devin-agent">[] = [
	devinModel("swe-2-high", "SWE-2 (high)", SWE_2_CONTEXT_WINDOW),
	devinModel("swe-2-medium", "SWE-2 (medium)", SWE_2_CONTEXT_WINDOW),
	devinModel("swe-2-max", "SWE-2 (max)", SWE_2_CONTEXT_WINDOW),
	devinModel("swe-1-6", "SWE-1.6", SWE_1_6_CONTEXT_WINDOW),
	devinModel("swe-1-6-fast", "SWE-1.6 Fast", SWE_1_6_CONTEXT_WINDOW),
];
