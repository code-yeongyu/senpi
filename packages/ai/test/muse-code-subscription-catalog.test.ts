import { describe, expect, it } from "vitest";
import { MODELS } from "../src/models.generated.ts";
import { getBuiltinModels } from "../src/providers/all.ts";
import { MUSE_CODE_SUBSCRIPTION_MODELS } from "../src/providers/muse-code-subscription.models.ts";
import { museCodeSubscriptionProvider } from "../src/providers/muse-code-subscription.ts";

describe("Muse Code subscription catalog", () => {
	it("ships four fork-owned models served by the muse CLI", () => {
		expect(Object.keys(MODELS)).not.toContain("muse-code-subscription");
		expect(Object.values(MUSE_CODE_SUBSCRIPTION_MODELS)).toHaveLength(4);
		expect(getBuiltinModels("muse-code-subscription")).toHaveLength(4);

		const provider = museCodeSubscriptionProvider();
		expect(provider).toMatchObject({
			id: "muse-code-subscription",
			name: "Muse Code (subscription, via muse CLI)",
			baseUrl: "muse://local",
		});
		expect(provider.getModels()).toHaveLength(4);
		expect(provider.getModels().every((model) => model.api === "muse-code-cli")).toBe(true);
	});

	it("maps Muse 1.3 efforts directly and disables off", () => {
		const model = MUSE_CODE_SUBSCRIPTION_MODELS["muse-spark-1.3"];
		expect(model.thinkingLevelMap).toEqual({
			off: null,
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
		expect(model).toMatchObject({
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_007_997,
			maxTokens: 128_000,
		});
	});

	it("keeps max unavailable on both Muse 1.2 variants", () => {
		for (const id of ["muse-spark-1.2", "muse-spark-1.2-contributor"] as const) {
			expect(MUSE_CODE_SUBSCRIPTION_MODELS[id].thinkingLevelMap?.max).toBeNull();
		}
	});

	it("labels contributor variants with the product-improvement notice", () => {
		for (const id of ["muse-spark-1.3-contributor", "muse-spark-1.2-contributor"] as const) {
			expect(MUSE_CODE_SUBSCRIPTION_MODELS[id].name).toContain("content may be used for product improvement");
		}
	});
});
