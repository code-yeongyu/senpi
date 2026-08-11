import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { FavoriteModelsSelectorComponent } from "../src/modes/interactive/components/favorite-models-selector.ts";
import type { FavoriteModelIds } from "../src/modes/interactive/components/model-favorites.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

interface RenderedRow {
	selected: boolean;
	favorite: boolean;
	id: string;
}

function parseRenderedRows(selector: FavoriteModelsSelectorComponent, provider: string): RenderedRow[] {
	return stripAnsi(selector.render(120).join("\n"))
		.split("\n")
		.filter((line) => line.includes(`[${provider}]`))
		.map((line) => {
			const trimmed = line.trim();
			const selected = trimmed.startsWith("→");
			const body = selected ? trimmed.replace(/^→\s*/, "") : trimmed;
			const favorite = body.startsWith("*");
			const id = body.slice(1).trim().split(" [")[0]?.trim() ?? "";
			return { selected, favorite, id };
		});
}

function createSelector(
	harness: Harness,
	favoriteModelIds: FavoriteModelIds,
	changes: Array<string[] | null>,
): FavoriteModelsSelectorComponent {
	return new FavoriteModelsSelectorComponent(
		{
			allModels: [...harness.models],
			favoriteModelIds,
		},
		{
			onChange: (nextFavoriteIds) => {
				changes.push(nextFavoriteIds);
			},
			onPersist: () => {},
			onSelect: () => {},
			onCancel: () => {},
		},
	);
}

describe("favorite models frozen order", () => {
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

	async function createThreeModelHarness(): Promise<{ harness: Harness; ids: string[]; provider: string }> {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
				{ id: "faux-3", name: "Three", reasoning: true },
			],
		});
		harnesses.push(harness);
		const provider = harness.models[0]?.provider ?? "faux";
		const ids = harness.models.map((model) => `${model.provider}/${model.id}`);
		return { harness, ids, provider };
	}

	it("freezes row order when unfavoriting a middle row, flipping only the marker", async () => {
		const { harness, ids, provider } = await createThreeModelHarness();
		const changes: Array<string[] | null> = [];
		const selector = createSelector(harness, [...ids], changes);

		selector.handleInput("\x1b[B"); // select the middle row
		selector.handleInput("\x06"); // Ctrl+F: unfavorite it

		const rows = parseRenderedRows(selector, provider);
		expect(rows.map((row) => row.id)).toEqual(["faux-1", "faux-2", "faux-3"]);
		expect(rows[1]).toMatchObject({ selected: true, favorite: false, id: "faux-2" });
		expect(changes).toEqual([[ids[0], ids[2]]]);
	});

	it("keeps frozen order when re-favoriting, appending the id last in the change payload", async () => {
		const { harness, ids, provider } = await createThreeModelHarness();
		const changes: Array<string[] | null> = [];
		const selector = createSelector(harness, [...ids], changes);

		selector.handleInput("\x1b[B"); // select the middle row
		selector.handleInput("\x06"); // Ctrl+F: unfavorite it
		selector.handleInput("\x06"); // Ctrl+F: re-favorite it

		const rows = parseRenderedRows(selector, provider);
		expect(rows.map((row) => row.id)).toEqual(["faux-1", "faux-2", "faux-3"]);
		expect(rows[1]).toMatchObject({ selected: true, favorite: true, id: "faux-2" });
		expect(changes).toEqual([
			[ids[0], ids[2]],
			[ids[0], ids[2], ids[1]],
		]);
	});

	it("still swaps rendered rows with reorder keys and emits the scoped order payload", async () => {
		const { harness, ids, provider } = await createThreeModelHarness();
		const changes: Array<string[] | null> = [];
		const selector = createSelector(harness, [...ids], changes);

		selector.handleInput("\x1b[1;3B"); // Alt+Down: move the first row down

		const rows = parseRenderedRows(selector, provider);
		expect(rows.map((row) => row.id)).toEqual(["faux-2", "faux-1", "faux-3"]);
		expect(rows[1]).toMatchObject({ selected: true, favorite: true, id: "faux-1" });
		expect(changes).toEqual([[ids[1], ids[0], ids[2]]]);
	});

	it("reflects the new membership order when reopened with mutated favorite ids", async () => {
		const { harness, ids, provider } = await createThreeModelHarness();
		const changes: Array<string[] | null> = [];
		const selector = createSelector(harness, [...ids], changes);

		selector.handleInput("\x1b[B"); // select the middle row
		selector.handleInput("\x06"); // Ctrl+F: unfavorite it
		const mutated = changes[changes.length - 1] ?? null;

		const reopened = createSelector(harness, mutated === null ? null : [...mutated], []);
		const rows = parseRenderedRows(reopened, provider);
		expect(rows.map((row) => row.id)).toEqual(["faux-1", "faux-3", "faux-2"]);
		expect(rows.map((row) => row.favorite)).toEqual([true, true, false]);
	});

	it("still matches the canonical provider/id recall query from issue #3217", async () => {
		const harness = await createHarness({
			provider: "openai",
			models: [
				{ id: "gpt-5-4-mini-fast", name: "GPT 5.4 Mini Fast", reasoning: true },
				{ id: "gpt-5.4", name: "GPT 5.4", reasoning: true },
				{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true },
			],
		});
		harnesses.push(harness);
		const selector = createSelector(harness, null, []);

		for (const char of "openai/gpt 5 4 mini fast") {
			selector.handleInput(char);
		}

		const rendered = stripAnsi(selector.render(120).join("\n"));
		expect(rendered).toContain("gpt-5-4-mini-fast [openai]");
		expect(rendered).not.toContain("claude-sonnet-4-5");
	});
});
