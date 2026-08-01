import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, model } from "./recommended-models-harness.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("recommended-models headless session scope", () => {
	it("#given a headless session #when an implicit-fallback provenance starts #then it switches without persisting defaults", async () => {
		for (const mode of ["print", "rpc", "json"] as const) {
			const kimi = model("kimi-k3", "kimi-coding");
			const harness = createHarness({ active: model("off-list"), available: [kimi], mode });

			await harness.start("first-available");

			expect(harness.getActiveModel()).toBe(kimi);
			expect(harness.getThinkingLevel()).toBe("max");
			expect(harness.settings.getDefaultProvider()).toBeUndefined();
			expect(harness.settings.getDefaultModel()).toBeUndefined();
			expect(harness.settings.getDefaultThinkingLevel()).toBeUndefined();
			expect(harness.notices).toEqual([{ message: "Switched to recommended model 'kimi-k3'.", type: "info" }]);
		}
	});

	it("#given a tui session #when an implicit-fallback provenance starts #then it still persists the recommendation", async () => {
		const kimi = model("kimi-k3", "kimi-coding");
		const harness = createHarness({ active: model("off-list"), available: [kimi], mode: "tui" });

		await harness.start("first-available");

		expect(harness.getActiveModel()).toBe(kimi);
		expect(harness.settings.getDefaultProvider()).toBe("kimi-coding");
		expect(harness.settings.getDefaultModel()).toBe("kimi-k3");
		expect(harness.settings.getDefaultThinkingLevel()).toBe("max");
	});
});
