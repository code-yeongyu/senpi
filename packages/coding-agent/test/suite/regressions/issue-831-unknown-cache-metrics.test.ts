import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { estimateCacheWarmMetrics } from "../../../src/core/extensions/builtin/goal/cache-warm.ts";

function unknownModel(): Model<Api> {
	return {
		id: "unknown-cache-test",
		name: "Unknown Cache Test",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200_000,
		maxTokens: 8192,
	} as Model<Api>;
}

describe("issue #831 unknown cache metrics compatibility", () => {
	it("omits cache metrics when the unknown lane has no cached tokens", () => {
		expect(estimateCacheWarmMetrics(unknownModel(), {}, { cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
	});
});
