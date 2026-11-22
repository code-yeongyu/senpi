import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, model } from "./recommended-models-harness.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("recommended-models headless session scope", () => {
	it("#given a headless session #when an implicit-fallback provenance starts #then it switches without persisting defaults", async () => {
		for (const mode of ["print", "rpc", "json"] as const) {
			const kimi = model("k3.1-pro", "kimi-coding");
			const harness = createHarness({ active: model("off-list"), available: [kimi], mode });

			await harness.start("first-available");

			expect(harness.getActiveModel()).toBe(kimi);
			expect(harness.getThinkingLevel()).toBe("max");
			expect(harness.settings.getDefaultProvider()).toBeUndefined();
			expect(harness.settings.getDefaultModel()).toBeUndefined();
			expect(harness.settings.getDefaultThinkingLevel()).toBeUndefined();
			expect(harness.notices).toEqual([{ message: "Switched to recommended model 'k3.1-pro'.", type: "info" }]);
		}
	});

	it("#given a tui session #when an implicit-fallback provenance starts #then it still persists the recommendation", async () => {
		const kimi = model("k3.1-pro", "kimi-coding");
		const harness = createHarness({ active: model("off-list"), available: [kimi], mode: "tui" });

		await harness.start("first-available");

		expect(harness.getActiveModel()).toBe(kimi);
		expect(harness.settings.getDefaultProvider()).toBe("kimi-coding");
		expect(harness.settings.getDefaultModel()).toBe("k3.1-pro");
		expect(harness.settings.getDefaultThinkingLevel()).toBe("max");
	});
});
