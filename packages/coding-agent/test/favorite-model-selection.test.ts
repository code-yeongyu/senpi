import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { FavoriteModelsSelectorComponent } from "../src/modes/interactive/components/favorite-models-selector.js";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { createHarness } from "./suite/harness.js";

function createFakeTui(): { requestRender: () => void } {
	return {
		requestRender: () => {},
	};
}

async function waitForAsyncRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("favorite model selection", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("selects the highlighted favorite model with enter and toggles favorite state with Ctrl+F", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
		});
		const [modelOne, modelTwo] = harness.models;
		const favoriteIds = harness.models.map((model) => `${model.provider}/${model.id}`);
		const selectedModels: string[] = [];
		const changes: Array<string[] | null> = [];

		try {
			const selector = new FavoriteModelsSelectorComponent(
				{
					allModels: [...harness.models],
					favoriteModelIds: favoriteIds,
				},
				{
					onChange: (nextFavoriteIds) => {
						changes.push(nextFavoriteIds);
					},
					onPersist: () => {},
					onCancel: () => {},
					onSelect: (model) => {
						selectedModels.push(`${model.provider}/${model.id}`);
					},
				},
			);

			selector.handleInput("\r");
			selector.handleInput("\x06");

			expect(selectedModels).toEqual([`${modelOne.provider}/${modelOne.id}`]);
			expect(changes).toEqual([[`${modelTwo.provider}/${modelTwo.id}`]]);
			expect(stripAnsi(selector.render(120).join("\n"))).toContain("→ - faux-1");
		} finally {
			harness.cleanup();
		}
	});

	it("toggles the highlighted /model row as a favorite with Ctrl+F", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
		});
		const [modelOne] = harness.models;
		const changes: Array<string[] | null> = [];

		try {
			const selector = new ModelSelectorComponent(
				createFakeTui(),
				modelOne,
				harness.settingsManager,
				harness.session.modelRegistry,
				[],
				() => {},
				() => {},
				undefined,
				{
					favoriteModelIds: [],
					onFavoriteChange: (favoriteModelIds) => {
						changes.push(favoriteModelIds);
					},
				},
			);

			await waitForAsyncRender();
			selector.handleInput("\x06");

			expect(changes).toEqual([[`${modelOne.provider}/${modelOne.id}`]]);
			expect(stripAnsi(selector.render(120).join("\n"))).toContain("* faux-1");
		} finally {
			harness.cleanup();
		}
	});
});
