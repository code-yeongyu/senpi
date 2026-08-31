import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../../../src/modes/interactive/components/model-selector.ts";
import { initTheme, theme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../harness.ts";

function createFakeTui(requestRender: () => void = () => {}): TUI {
	return { requestRender } as unknown as TUI;
}

function rendered(selector: ModelSelectorComponent): string {
	return stripAnsi(selector.render(120).join("\n"));
}

function rawScopeLine(selector: ModelSelectorComponent): string {
	const line = selector.render(120).find((candidate) => stripAnsi(candidate).includes("Catalog:"));
	if (!line) throw new Error("Expected catalog scope line");
	return line;
}

async function waitForRefresh(selector: ModelSelectorComponent): Promise<void> {
	await vi.waitFor(() => {
		expect(rendered(selector)).toContain("Model catalogs refreshed.");
	});
}

/** Register a second provider lane so one model id exists under two providers. */
async function addProviderLane(harness: Harness, provider: string, modelIds: string[]): Promise<void> {
	const lane = registerFauxProvider({
		provider,
		models: modelIds.map((id) => ({ id, name: `${provider} ${id}`, reasoning: false })),
	});
	await harness.authStorage.modify(provider, async () => ({ type: "api_key", key: "faux-key-b" }));
	harness.modelRegistry.registerProvider(provider, {
		baseUrl: lane.models[0].baseUrl,
		apiKey: "faux-key-b",
		api: lane.api,
		models: lane.models.map((registeredModel) => ({
			id: registeredModel.id,
			name: registeredModel.name,
			api: registeredModel.api,
			reasoning: registeredModel.reasoning,
			input: registeredModel.input,
			cost: registeredModel.cost,
			contextWindow: registeredModel.contextWindow,
			maxTokens: registeredModel.maxTokens,
			baseUrl: registeredModel.baseUrl,
		})),
	});
}

describe("model selector catalog view modes", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("cycles all → favorites → by-model with Tab and filters the favorites view", async () => {
		const harness = await createHarness({
			models: [
				{ id: "alpha-1", name: "Alpha One", reasoning: true },
				{ id: "beta-1", name: "Beta One", reasoning: true },
				{ id: "omega-1", name: "Omega One", reasoning: true },
			],
		});
		harnesses.push(harness);
		const provider = harness.models[0].provider;
		const requestRender = vi.fn();

		const selector = new ModelSelectorComponent(
			createFakeTui(requestRender),
			harness.getModel("alpha-1")!,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			{ favoriteModelIds: [`${provider}/beta-1`] },
		);
		await waitForRefresh(selector);

		const header = rendered(selector);
		expect(header).toContain("all");
		expect(header).toContain("favorites");
		expect(header).toContain("by-model");
		expect(header).toContain("beta-1");
		expect(header).toContain("omega-1");
		expect(rawScopeLine(selector)).toContain(theme.fg("accent", "all"));
		const renderCallsBeforeTabs = requestRender.mock.calls.length;

		selector.handleInput("\t");
		expect(rawScopeLine(selector)).toContain(theme.fg("accent", "favorites"));
		const favoritesView = rendered(selector);
		expect(favoritesView).toContain("beta-1");
		expect(favoritesView).not.toContain("omega-1");

		selector.handleInput("\t");
		expect(rawScopeLine(selector)).toContain(theme.fg("accent", "by-model"));
		const byModelView = rendered(selector);
		expect(byModelView).toContain("alpha-1");
		expect(byModelView).toContain("beta-1");

		selector.handleInput("\t");
		expect(rawScopeLine(selector)).toContain(theme.fg("accent", "all"));
		const backToAll = rendered(selector);
		expect(backToAll).toContain("omega-1");
		expect(requestRender).toHaveBeenCalledTimes(renderCallsBeforeTabs + 3);
	});

	it("shows an empty-state hint in the favorites view when nothing is favorited", async () => {
		const harness = await createHarness({
			models: [{ id: "alpha-1", name: "Alpha One", reasoning: true }],
		});
		harnesses.push(harness);

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			{ favoriteModelIds: [] },
		);
		await waitForRefresh(selector);

		selector.handleInput("\t");
		expect(rendered(selector)).toContain("No favorite models yet");
	});

	it("groups one row per model id across providers and drills into provider lanes", async () => {
		const harness = await createHarness({
			provider: "prov-a",
			models: [
				{ id: "shared-model", name: "Shared", reasoning: true },
				{ id: "solo-a", name: "Solo A", reasoning: false },
			],
		});
		harnesses.push(harness);
		await addProviderLane(harness, "prov-b", ["shared-model"]);

		const selected: string[] = [];
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("shared-model"),
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			(model) => selected.push(`${model.provider}/${model.id}`),
			() => {},
			undefined,
			{ favoriteModelIds: [] },
		);
		await waitForRefresh(selector);

		// all → favorites → by-model
		selector.handleInput("\t");
		selector.handleInput("\t");
		const grouped = rendered(selector);
		expect(grouped).toContain("[2 providers]");
		expect(grouped).toContain("shared-model");
		expect(grouped).toContain("solo-a");

		// Enter on the grouped row drills into its provider lanes.
		const sharedIndex = rendered(selector)
			.split("\n")
			.findIndex((line) => line.includes("shared-model"));
		expect(sharedIndex).toBeGreaterThanOrEqual(0);
		// The group list is ordered current-first, so shared-model leads.
		selector.handleInput("\r");
		const lanes = rendered(selector);
		expect(lanes).toContain("[prov-a]");
		expect(lanes).toContain("[prov-b]");
		expect(lanes).not.toContain("[2 providers]");

		// Pick the second lane (prov-b).
		selector.handleInput("\x1b[B");
		selector.handleInput("\r");
		expect(selected).toEqual(["prov-b/shared-model"]);
	});

	it("collapses a drill-down with Escape before cancelling the selector", async () => {
		const harness = await createHarness({
			provider: "prov-a",
			models: [{ id: "shared-model", name: "Shared", reasoning: true }],
		});
		harnesses.push(harness);
		await addProviderLane(harness, "prov-b", ["shared-model"]);

		let cancelled = false;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("shared-model"),
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {
				cancelled = true;
			},
			undefined,
			{ favoriteModelIds: [] },
		);
		await waitForRefresh(selector);

		selector.handleInput("\t");
		selector.handleInput("\t");
		selector.handleInput("\r");
		expect(rendered(selector)).toContain("[prov-b]");

		selector.handleInput("\x1b");
		expect(cancelled).toBe(false);
		expect(rendered(selector)).toContain("[2 providers]");

		selector.handleInput("\x1b");
		expect(cancelled).toBe(true);
	});

	it("hides access-denied models from every view and shows a footer note", async () => {
		const harness = await createHarness({
			models: [
				{ id: "alpha-1", name: "Alpha One", reasoning: true },
				{ id: "beta-1", name: "Beta One", reasoning: true },
				{ id: "omega-1", name: "Omega One", reasoning: true },
			],
		});
		harnesses.push(harness);
		const provider = harness.models[0].provider;

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("alpha-1")!,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			{ favoriteModelIds: [`${provider}/omega-1`] },
			{ unavailableModelIds: new Set([`${provider}/omega-1`]) },
		);
		await waitForRefresh(selector);

		const allView = rendered(selector);
		expect(allView).toContain("alpha-1");
		expect(allView).toContain("beta-1");
		expect(allView).not.toContain("omega-1");
		expect(allView).toContain("1 unavailable model(s) hidden");

		// The hidden model stays hidden even in the favorites view it belongs to.
		selector.handleInput("\t");
		const favoritesView = rendered(selector);
		expect(favoritesView).not.toContain("omega-1");
		expect(favoritesView).toContain("No favorite models yet");
	});

	it("keeps narrowed in the Tab cycle when scoped models are configured", async () => {
		const harness = await createHarness({
			models: [
				{ id: "alpha-1", name: "Alpha One", reasoning: true },
				{ id: "beta-1", name: "Beta One", reasoning: true },
			],
		});
		harnesses.push(harness);

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("alpha-1"),
			harness.settingsManager,
			harness.session.modelRuntime,
			[{ model: harness.getModel("beta-1")! }],
			() => {},
			() => {},
			undefined,
			{ favoriteModelIds: [] },
		);
		await waitForRefresh(selector);

		// Scoped catalogs open in the narrowed view.
		const initial = rendered(selector);
		expect(initial).toContain("narrowed");
		expect(initial).toContain("beta-1");
		expect(initial).not.toContain("alpha-1");

		selector.handleInput("\t");
		expect(rendered(selector)).toContain("alpha-1");
	});
});
