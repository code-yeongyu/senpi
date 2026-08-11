import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../../../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

/** Ordered model ids of the rendered list rows (rows carry a `[provider]` badge). */
function listRowIds(rendered: string, provider: string): string[] {
	return rendered
		.split("\n")
		.filter((line) => line.includes(`[${provider}]`))
		.map(
			(line) =>
				line
					.trim()
					.replace(/^→\s*/, "")
					.replace(/^\*\s*/, "")
					.split(" [")[0]
					?.trim() ?? "",
		);
}

async function waitForRefresh(selector: ModelSelectorComponent): Promise<void> {
	await vi.waitFor(() => {
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("Model catalogs refreshed.");
	});
}

function typeQuery(selector: ModelSelectorComponent, query: string): void {
	for (const char of query) {
		selector.handleInput(char);
	}
}

describe("model selector favorites-first search with frozen session ordering", () => {
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

	// Plan todo 2 case (i): a favorite and a non-favorite with identical relevance
	// must order favorite-first. The current model is the non-favorite tie-partner,
	// so it leads the base order and only the favorites partition can flip the
	// result (relevance costs and id length tie; inputIndex never gets to decide).
	it("ranks a favorite above the non-favorite current model when search relevance ties", async () => {
		const harness = await createHarness({
			models: [
				{ id: "opus-a", name: "Claude Opus 5", reasoning: true },
				{ id: "opus-b", name: "Claude Opus 5", reasoning: true },
			],
		});
		harnesses.push(harness);
		const provider = harness.models[0].provider;
		const current = harness.getModel("opus-a")!;

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			current,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			{ favoriteModelIds: [`${provider}/opus-b`] },
		);
		await waitForRefresh(selector);

		typeQuery(selector, "claude opus 5");

		const rendered = stripAnsi(selector.render(120).join("\n"));
		expect(listRowIds(rendered, provider)).toEqual(["opus-b", "opus-a"]);
	});

	// Plan todo 2 case (ii): Ctrl+F mid-session must not reorder rows; only the
	// `*` marker changes. Without the fix the toggled row (omega-1) jumps above
	// beta-1 because the list is re-sorted favorites-first on every toggle.
	it("keeps row order frozen when toggling a favorite mid-session", async () => {
		const harness = await createHarness({
			models: [
				{ id: "alpha-1", name: "Alpha One", reasoning: true },
				{ id: "beta-1", name: "Beta One", reasoning: true },
				{ id: "omega-1", name: "Omega One", reasoning: true },
			],
		});
		harnesses.push(harness);
		const provider = harness.models[0].provider;
		const current = harness.getModel("alpha-1")!;
		const changes: Array<string[] | null> = [];

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			current,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			{
				favoriteModelIds: [],
				onFavoriteChange: (favoriteModelIds) => {
					changes.push(favoriteModelIds === null ? null : [...favoriteModelIds]);
				},
			},
		);
		await waitForRefresh(selector);

		const before = stripAnsi(selector.render(120).join("\n"));
		expect(listRowIds(before, provider)).toEqual(["alpha-1", "beta-1", "omega-1"]);
		expect(before).not.toContain("* omega-1");

		// Select omega-1 (bottom row) and favorite it with Ctrl+F.
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\x06");

		const after = stripAnsi(selector.render(120).join("\n"));
		expect(listRowIds(after, provider)).toEqual(["alpha-1", "beta-1", "omega-1"]);
		expect(after).toContain("* omega-1");
		expect(changes).toEqual([[`${provider}/omega-1`]]);
	});

	// Plan todo 2 case (iii), search half: with the null all-favorite sentinel the
	// partition is a no-op, so search order is pure relevance (the current model
	// gets no favorites boost and loses to the more relevant row).
	it("orders search by pure relevance when favoriteModelIds is null", async () => {
		const harness = await createHarness({
			provider: "anthropic",
			models: [
				{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true },
				{ id: "claude-opus-5", name: "Claude Opus 5", reasoning: true },
				{ id: "claude-fable-5", name: "Claude Fable 5", reasoning: true },
			],
		});
		harnesses.push(harness);
		const current = harness.getModel("claude-sonnet-4-5")!;

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			current,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			{ favoriteModelIds: null },
		);
		await waitForRefresh(selector);

		typeQuery(selector, "opus");

		const rendered = stripAnsi(selector.render(120).join("\n"));
		expect(listRowIds(rendered, "anthropic")).toEqual(["claude-opus-5", "claude-sonnet-4-5"]);
		// Null sentinel: every row keeps the all-favorite marker.
		expect(rendered).toContain("* claude-opus-5");
		expect(rendered).toContain("* claude-sonnet-4-5");
	});

	// Plan todo 2 case (iii), toggle half: the first toggle materializes the null
	// sentinel into an explicit list; rows must not reshuffle when that happens.
	it("does not reshuffle rows on the first toggle from the null favorites sentinel", async () => {
		const harness = await createHarness({
			provider: "anthropic",
			models: [
				{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true },
				{ id: "claude-opus-5", name: "Claude Opus 5", reasoning: true },
				{ id: "claude-fable-5", name: "Claude Fable 5", reasoning: true },
			],
		});
		harnesses.push(harness);
		const current = harness.getModel("claude-sonnet-4-5")!;
		const changes: Array<string[] | null> = [];

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			current,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			{
				favoriteModelIds: null,
				onFavoriteChange: (favoriteModelIds) => {
					changes.push(favoriteModelIds === null ? null : [...favoriteModelIds]);
				},
			},
		);
		await waitForRefresh(selector);

		const before = stripAnsi(selector.render(120).join("\n"));
		expect(listRowIds(before, "anthropic")).toEqual(["claude-sonnet-4-5", "claude-fable-5", "claude-opus-5"]);
		expect(before).toContain("* claude-fable-5");

		// Unfavorite claude-fable-5 (middle row): null -> explicit list.
		selector.handleInput("\x1b[B");
		selector.handleInput("\x06");

		const after = stripAnsi(selector.render(120).join("\n"));
		expect(listRowIds(after, "anthropic")).toEqual(["claude-sonnet-4-5", "claude-fable-5", "claude-opus-5"]);
		expect(after).not.toContain("* claude-fable-5");
		expect(changes).toEqual([["anthropic/claude-sonnet-4-5", "anthropic/claude-opus-5"]]);
	});
});
