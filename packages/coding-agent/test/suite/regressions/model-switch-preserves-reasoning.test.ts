import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function requireModel(harness: Harness, id: string): Model<string> {
	const model = harness.getModel(id);
	if (!model) throw new Error(`Missing test model: ${id}`);
	return model;
}

describe("model switching preserves the preferred reasoning level", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("preserves the preferred reasoning level across manual model switches", async () => {
		const harness = await createHarness({
			models: [
				{ id: "claude-opus-4-8", reasoning: true },
				{ id: "faux-basic", reasoning: true },
			],
		});
		harnesses.push(harness);
		const maxModel = requireModel(harness, "claude-opus-4-8");
		const basicModel = requireModel(harness, "faux-basic");
		harness.session.setThinkingLevel("max");

		await harness.session.setModel(basicModel);

		expect(harness.session.thinkingLevel).toBe("high");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("max");

		await harness.session.setModel(maxModel);

		expect(harness.session.thinkingLevel).toBe("max");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("max");
	});

	it("preserves the preferred reasoning level across favorite model cycling", async () => {
		const harness = await createHarness({
			models: [
				{ id: "claude-opus-4-8", reasoning: true },
				{ id: "faux-basic", reasoning: true },
			],
		});
		harnesses.push(harness);
		const maxModel = requireModel(harness, "claude-opus-4-8");
		const basicModel = requireModel(harness, "faux-basic");
		harness.session.setFavoriteModels([{ model: maxModel }, { model: basicModel }]);
		harness.session.setThinkingLevel("max");

		await harness.session.cycleModel();

		expect(harness.session.thinkingLevel).toBe("high");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("max");

		await harness.session.cycleModel();

		expect(harness.session.thinkingLevel).toBe("max");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("max");
	});

	it("does not replace the preferred reasoning level with a favorite override", async () => {
		const harness = await createHarness({
			models: [
				{ id: "claude-opus-4-8", reasoning: true },
				{ id: "faux-basic", reasoning: true },
			],
		});
		harnesses.push(harness);
		const maxModel = requireModel(harness, "claude-opus-4-8");
		const basicModel = requireModel(harness, "faux-basic");
		harness.session.setFavoriteModels([{ model: maxModel }, { model: basicModel, thinkingLevel: "low" }]);
		harness.session.setThinkingLevel("max");

		await harness.session.cycleModel();

		expect(harness.session.thinkingLevel).toBe("low");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("max");

		await harness.session.cycleModel();

		expect(harness.session.thinkingLevel).toBe("max");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("max");
	});
});
