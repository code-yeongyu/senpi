import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession scoped settings", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("characterizes setModel as updating the global model defaults", async () => {
		// Given: a session with an authenticated second model and empty global defaults.
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
		});
		harnesses.push(harness);
		const nextModel = harness.getModel("faux-2");
		if (!nextModel) throw new Error("missing faux-2 model");

		// When: the existing global-setting model setter is used.
		await harness.session.setModel(nextModel);

		// Then: its current global-default side effect remains characterized.
		expect(harness.settingsManager.getDefaultProvider()).toBe(nextModel.provider);
		expect(harness.settingsManager.getDefaultModel()).toBe(nextModel.id);
	});

	it("changes only this session when setSessionModel is used", async () => {
		// Given: a session whose global defaults have a known baseline.
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			settings: { defaultProvider: "global-provider", defaultModel: "global-model" },
		});
		harnesses.push(harness);
		const nextModel = harness.getModel("faux-2");
		if (!nextModel) throw new Error("missing faux-2 model");

		// When: the session-scoped model setter is used.
		await harness.session.setSessionModel(nextModel);

		// Then: the selected session model and its history change, but global defaults do not.
		expect(harness.session.model?.id).toBe(nextModel.id);
		expect(harness.settingsManager.getDefaultProvider()).toBe("global-provider");
		expect(harness.settingsManager.getDefaultModel()).toBe("global-model");
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "model_change")
				.map((entry) => `${entry.provider}/${entry.modelId}`),
		).toEqual([`${nextModel.provider}/${nextModel.id}`]);
	});

	it("changes only this session when setSessionThinkingLevel is used", async () => {
		// Given: a reasoning-capable session with a known global thinking default.
		const harness = await createHarness({
			models: [{ id: "faux-1", name: "One", reasoning: true }],
			settings: { defaultThinkingLevel: "low" },
		});
		harnesses.push(harness);

		// When: the session-scoped thinking setter is used.
		harness.session.setSessionThinkingLevel("high");

		// Then: the session and history change, while the global thinking default remains low.
		expect(harness.session.thinkingLevel).toBe("high");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("low");
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "thinking_level_change")
				.map((entry) => entry.thinkingLevel),
		).toEqual(["high"]);
	});
});
