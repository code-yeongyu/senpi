/**
 * Elorian's fork-owned catalog: models.dev does not list this provider.
 * https://platform.elorian.ai/settings/docs#sdk-compatibility
 * Account-specific limits are refreshed from GET /v1/limits.
 */
import type { Model } from "../types.ts";
import { ELORIAN_COMPLETIONS_COMPAT, ELORIAN_THINKING_LEVEL_MAP } from "./elorian-stream.ts";

export const ELORIAN_MODELS = {
	"elorian-1-agent": {
		id: "elorian-1-agent",
		name: "Elorian Glimpse",
		api: "openai-completions",
		provider: "elorian",
		baseUrl: "https://api.elorian.ai/v1",
		reasoning: true,
		defaultThinkingLevel: "xhigh",
		thinkingLevelMap: ELORIAN_THINKING_LEVEL_MAP,
		input: ["text", "image", "video"],
		inputLimits: {
			images: {
				resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024, jpegQuality: 80 },
			},
		},
		cost: { input: 0.6, output: 3, cacheRead: 0.06, cacheWrite: 0 },
		contextWindow: 220_000,
		maxTokens: 8_000,
		compat: ELORIAN_COMPLETIONS_COMPAT,
	},
} satisfies Record<string, Model<"openai-completions">>;
