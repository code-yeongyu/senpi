import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, type Model, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function requireModel(harness: Harness, id: string): Model<string> {
	const model = harness.getModel(id);
	if (!model) throw new Error(`Missing test model: ${id}`);
	return model;
}

function makeOnOffOnly(model: Model<string>): void {
	model.thinkingLevelMap = {
		minimal: null,
		low: null,
		medium: null,
		xhigh: null,
		max: null,
	} as ThinkingLevelMap;
}

async function readSettings(harness: Harness): Promise<Record<string, unknown>> {
	await harness.settingsManager.flush();
	return JSON.parse(readFileSync(join(harness.tempDir, "agent", "settings.json"), "utf8")) as Record<string, unknown>;
}

describe("per-model thinking memory", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("characterizes the global default scalar overwritten by each persistent manual choice", async () => {
		const harness = await createHarness({
			fileSettings: true,
			models: [
				{ id: "gpt-5.6-sol", reasoning: true },
				{ id: "on-off-b", reasoning: true },
			],
		});
		harnesses.push(harness);
		const modelA = requireModel(harness, "gpt-5.6-sol");
		const modelB = requireModel(harness, "on-off-b");
		makeOnOffOnly(modelB);
		harness.session.setFavoriteModels([{ model: modelA }, { model: modelB }]);

		harness.session.setThinkingLevel("xhigh");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("xhigh");

		await harness.session.cycleModel();
		harness.session.setThinkingLevel("off");

		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("off");
		expect(await readSettings(harness)).toMatchObject({ defaultThinkingLevel: "off" });
	});

	it("restores each favorite model's manual level across repeated cycles and persists both memories", async () => {
		const harness = await createHarness({
			fileSettings: true,
			models: [
				{ id: "gpt-5.6-sol", reasoning: true },
				{ id: "on-off-b", reasoning: true },
			],
		});
		harnesses.push(harness);
		const modelA = requireModel(harness, "gpt-5.6-sol");
		const modelB = requireModel(harness, "on-off-b");
		makeOnOffOnly(modelB);
		harness.session.setFavoriteModels([{ model: modelA }, { model: modelB }]);

		harness.session.setThinkingLevel("xhigh");
		await harness.session.cycleModel();
		expect(harness.session.thinkingLevel).toBe("high");
		harness.session.setThinkingLevel("off");

		await harness.session.cycleModel();
		expect(harness.session.thinkingLevel).toBe("xhigh");

		await harness.session.cycleModel();
		expect(harness.session.thinkingLevel).toBe("off");
		await harness.session.cycleModel();
		expect(harness.session.thinkingLevel).toBe("xhigh");

		expect(await readSettings(harness)).toMatchObject({
			modelThinkingLevels: {
				[`${modelA.provider}/${modelA.id}`]: "xhigh",
				[`${modelB.provider}/${modelB.id}`]: "off",
			},
		});
	});

	it("does not persist a fallback's ephemeral thinking level and preserves primary memory through revert", async () => {
		let now = 0;
		const primary = "faux/gpt-5.6-sol";
		const fallback = "faux/fallback-b";
		const harness = await createHarness({
			fileSettings: true,
			fallbackNow: () => now,
			models: [
				{ id: "gpt-5.6-sol", reasoning: true },
				{ id: "fallback-b", reasoning: true },
			],
			settings: {
				retry: {
					enabled: true,
					baseDelayMs: 1,
					maxRetries: 0,
					fallbackChains: { [primary]: [fallback] },
				},
			},
		});
		harnesses.push(harness);
		harness.session.setThinkingLevel("xhigh");
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("fallback answer"),
			fauxAssistantMessage("primary answer"),
		]);

		await harness.session.prompt("trigger fallback");
		expect(harness.session.model?.id).toBe("fallback-b");
		let settings = await readSettings(harness);
		expect(settings.modelThinkingLevels).toEqual({ [primary]: "xhigh" });

		now += 10 * 60_000;
		await harness.session.prompt("resume primary");
		expect(harness.session.model?.id).toBe("gpt-5.6-sol");
		settings = await readSettings(harness);
		expect(settings.modelThinkingLevels).toEqual({ [primary]: "xhigh" });
	});

	it("clamps a fallback's ephemeral level when reverting to a lower-capability primary", async () => {
		let now = 0;
		const primary = "faux/graded-a";
		const fallback = "faux/gpt-5.6-sol";
		const harness = await createHarness({
			fallbackNow: () => now,
			models: [
				{ id: "graded-a", reasoning: true },
				{ id: "gpt-5.6-sol", reasoning: true },
			],
			settings: {
				retry: {
					enabled: true,
					baseDelayMs: 1,
					maxRetries: 0,
					fallbackChains: { [primary]: [`${fallback}:xhigh`] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("fallback answer"),
			fauxAssistantMessage("primary answer"),
		]);

		await harness.session.prompt("trigger fallback");
		expect(harness.session.model?.id).toBe("gpt-5.6-sol");
		expect(harness.session.thinkingLevel).toBe("xhigh");

		harness.session.setSessionThinkingLevel("low");
		harness.session.setSessionThinkingLevel("xhigh");
		now += 10 * 60_000;
		await harness.session.prompt("resume primary");

		expect(harness.session.model?.id).toBe("graded-a");
		expect(harness.session.thinkingLevel).toBe("high");
		expect(harness.agent.state.thinkingLevel).toBe("high");
	});

	it("clamps stale stored memory at apply time without rewriting it", async () => {
		const harness = await createHarness({
			fileSettings: true,
			models: [
				{ id: "graded-a", reasoning: true },
				{ id: "on-off-b", reasoning: true },
			],
			settings: { modelThinkingLevels: { "faux/on-off-b": "xhigh" } },
		});
		harnesses.push(harness);
		const modelA = requireModel(harness, "graded-a");
		const modelB = requireModel(harness, "on-off-b");
		makeOnOffOnly(modelB);
		harness.session.setFavoriteModels([{ model: modelA }, { model: modelB }]);

		await harness.session.cycleModel();

		expect(harness.session.thinkingLevel).toBe("high");
		expect(await readSettings(harness)).toMatchObject({
			modelThinkingLevels: { "faux/on-off-b": "xhigh" },
		});
	});

	it("resolves a direct switch from the target model instead of leaking the previous session level", async () => {
		const harness = await createHarness({
			fileSettings: true,
			models: [
				{ id: "gpt-5.6-sol", reasoning: true },
				{ id: "graded-b", reasoning: true },
			],
		});
		harnesses.push(harness);
		const modelB = requireModel(harness, "graded-b");
		harness.session.setSessionThinkingLevel("xhigh");

		await harness.session.setSessionModel(modelB);

		expect(harness.session.thinkingLevel).toBe("medium");
		expect((await readSettings(harness)).modelThinkingLevels).toBeUndefined();
	});

	it("persists the clamped model memory even when the effective level is unchanged", async () => {
		const harness = await createHarness({
			fileSettings: true,
			models: [{ id: "graded-a", reasoning: true }],
		});
		harnesses.push(harness);
		const model = requireModel(harness, "graded-a");
		expect(harness.session.thinkingLevel).toBe("off");

		harness.session.setThinkingLevel("off");

		expect(await readSettings(harness)).toMatchObject({
			modelThinkingLevels: { [`${model.provider}/${model.id}`]: "off" },
		});
	});

	it("treats a favorite level as a non-persistent pin", async () => {
		const harness = await createHarness({
			fileSettings: true,
			models: [
				{ id: "graded-a", reasoning: true },
				{ id: "graded-b", reasoning: true },
			],
		});
		harnesses.push(harness);
		const modelA = requireModel(harness, "graded-a");
		const modelB = requireModel(harness, "graded-b");
		harness.session.setFavoriteModels([{ model: modelA }, { model: modelB, thinkingLevel: "low" }]);

		await harness.session.cycleModel();

		expect(harness.session.thinkingLevel).toBe("low");
		expect((await readSettings(harness)).modelThinkingLevels).toBeUndefined();
	});
});
