import { stripVTControlCharacters } from "node:util";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { ExtensionSelectorComponent } from "../../../src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";

/**
 * Issue #795: on large model registries the /fallback target selector rendered
 * every option at once. The overflowing list pushed past the viewport and the
 * moved highlight was never painted, so arrows and j/k looked dead even though
 * the selection moved underneath. The selector must window long lists.
 */
const OPTIONS = Array.from({ length: 60 }, (_, i) => `provider/model-${i + 1}`);

function createSelector(onSelect: (option: string) => void = () => {}): ExtensionSelectorComponent {
	return new ExtensionSelectorComponent("Fallback target model", OPTIONS, onSelect, () => {});
}

function renderedLines(selector: ExtensionSelectorComponent): string[] {
	return selector.render(100).map(stripVTControlCharacters);
}

describe("ExtensionSelectorComponent large-registry windowing (issue #795)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		// Keybindings are a global singleton; reset for isolation.
		setKeybindings(new KeybindingsManager());
	});

	test("windows long option lists instead of rendering every row", () => {
		const selector = createSelector();
		const optionRows = renderedLines(selector).filter((line) => line.includes("provider/model-"));
		expect(optionRows.length).toBeLessThanOrEqual(10);
	});

	test("moves the visible highlight on j/k and arrow keys", () => {
		const selector = createSelector();
		selector.handleInput("j");
		selector.handleInput("\x1b[B");
		const text = renderedLines(selector).join("\n");
		expect(text).toContain("→ provider/model-3");
	});

	test("keeps the highlight inside the window after navigating deep into the list", () => {
		const selector = createSelector();
		for (let i = 0; i < 30; i++) selector.handleInput("j");
		const rows = renderedLines(selector)
			.map((line) => line.trim())
			.filter((line) => line.includes("provider/model-"));
		const ids = rows.map((line) => line.replace(/^→\s*/, ""));
		expect(rows.some((line) => line.startsWith("→ provider/model-31"))).toBe(true);
		// The window scrolled: the first options are no longer rendered.
		expect(ids).not.toContain("provider/model-1");
		expect(ids).not.toContain("provider/model-2");
	});

	test("selects the highlighted option with enter after windowed navigation", () => {
		let selected: string | undefined;
		const selector = createSelector((option) => {
			selected = option;
		});
		for (let i = 0; i < 4; i++) selector.handleInput("j");
		selector.handleInput("\r");
		expect(selected).toBe("provider/model-5");
	});
});
