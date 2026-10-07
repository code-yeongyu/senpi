import { registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { computeAdaptiveThresholdRatio } from "../../src/core/extensions/builtin/compaction/policy.ts";

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

describe("compaction policy: large-window adaptive threshold tiers", () => {
	describe("Given faux models with context windows 256000, 512000 and 1000000", () => {
		describe("When the adaptive threshold ratio is computed for each window", () => {
			it("Then the large-window tiers resolve to 0.70, 0.70 and 0.80", () => {
				const registration = registerFauxProvider({
					models: [
						{ id: "faux-256k", contextWindow: 256000 },
						{ id: "faux-512k", contextWindow: 512000 },
						{ id: "faux-1m", contextWindow: 1000000 },
					],
				});
				registrations.push(registration);

				expect(computeAdaptiveThresholdRatio(256000)).toBe(0.7);
				expect(computeAdaptiveThresholdRatio(512000)).toBe(0.7);
				expect(computeAdaptiveThresholdRatio(1000000)).toBe(0.8);
			});
		});
	});
});
