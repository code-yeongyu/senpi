import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { FavoriteModelsSelectorComponent } from "../../../src/modes/interactive/components/favorite-models-selector.ts";
import { ModelSelectorComponent } from "../../../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../harness.ts";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as TUI;
}

describe("issue #3217 scoped model ordering", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		// Ensure test isolation: keybindings are a global singleton
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("propagates reordered scoped models back to the session state", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
				{ id: "faux-3", name: "Three", reasoning: true },
			],
		});
		harnesses.push(harness);

		const orderedIds = harness.models.map((model) => `${model.provider}/${model.id}`);
		const changes: Array<string[] | null> = [];
		const selector = new FavoriteModelsSelectorComponent(
			{
				allModels: [...harness.models],
				favoriteModelIds: orderedIds,
			},
			{
				onChange: (favoriteModelIds) => {
					changes.push(favoriteModelIds);
				},
				onPersist: () => {},
				onSelect: () => {},
				onCancel: () => {},
			},
		);

		selector.handleInput("\x1b[1;3B");

		expect(changes).toEqual([[orderedIds[1], orderedIds[0], orderedIds[2]]]);
	});

	it("filters scoped models by canonical provider/model id", async () => {
		const harness = await createHarness({
			provider: "openai",
			models: [
				{ id: "gpt-5-4-mini-fast", name: "GPT 5.4 Mini Fast", reasoning: true },
				{ id: "gpt-5.4", name: "GPT 5.4", reasoning: true },
				{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true },
			],
		});
		harnesses.push(harness);

		const selector = new FavoriteModelsSelectorComponent(
			{
				allModels: [...harness.models],
				favoriteModelIds: null,
			},
			{
				onChange: () => {},
				onPersist: () => {},
				onSelect: () => {},
				onCancel: () => {},
			},
		);

		for (const char of "openai/gpt 5 4 mini fast") {
			selector.handleInput(char);
		}

		const rendered = stripAnsi(selector.render(120).join("\n"));
		expect(rendered).toContain("gpt-5-4-mini-fast [openai]");
		expect(rendered).not.toContain("claude-sonnet-4-5");
	});

	it("preserves narrowed catalog order in the /model narrowed tab", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
				{ id: "faux-3", name: "Three", reasoning: true },
			],
		});
		harnesses.push(harness);

		const modelOne = harness.getModel("faux-1");
		const modelTwo = harness.getModel("faux-2");
		const modelThree = harness.getModel("faux-3");
		if (!modelOne || !modelTwo || !modelThree) {
			throw new Error("expected faux models to be registered");
		}
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			modelOne,
			harness.settingsManager,
			harness.session.modelRuntime,
			[{ model: modelTwo }, { model: modelOne }, { model: modelThree }],
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain(`[${modelOne.provider}]`);
			expect(rendered).toContain("Model catalogs refreshed.");
		});

		const renderedLines = stripAnsi(selector.render(120).join("\n"))
			.split("\n")
			.filter((line) => line.includes(`[${modelOne.provider}]`));
		const orderedIds = renderedLines.slice(0, 3).map((line) => {
			const [modelId] = line.trim().replace(/^→\s*/, "").split(" [");
			return modelId?.trim() ?? "";
		});

		expect(orderedIds).toEqual([modelTwo.id, modelOne.id, modelThree.id]);
	});
});
