import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

describe("model selector", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("keeps the current model marked while browsing", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "browsed-model", name: "Browsed Model", reasoning: true },
			],
		});
		const currentModel = harness.getModel("current-model")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		const getModelRow = (id: string): string | undefined =>
			stripAnsi(selector.render(120).join("\n"))
				.split("\n")
				.find((line) => line.includes(`${id} [`))
				?.trimEnd();

		// D6: the checkmark renders after the model name (upstream #8900 cheap markers).
		expect(getModelRow("current-model")).toBe(`→   current-model [${currentModel.provider}] ✓`);
		selector.handleInput("\x1b[B");
		expect(getModelRow("current-model")).toBe(`    current-model [${currentModel.provider}] ✓`);
		expect(getModelRow("browsed-model")).toBe(`→   browsed-model [${currentModel.provider}]`);
		selector.dispose();
	});

	// Upstream #9149 made the selector's separate "set as default" chord follow app.models.save.
	// The fork has no separate chord: confirming a model already persists it as the default, so a
	// rebound app.models.save must neither select nor save here, while confirm still does both.
	it("persists the default on confirm and ignores the rebound save chord", async () => {
		setKeybindings(new KeybindingsManager({ "app.models.save": "ctrl+r" }));
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "other-model", name: "Other Model", reasoning: true },
			],
		});
		const currentModel = harness.getModel("current-model")!;
		const onSelect = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			onSelect,
			() => {},
		);

		expect(stripAnsi(selector.render(120).join("\n"))).not.toContain("set as default");
		selector.handleInput("\x1b[B");
		selector.handleInput("\x13");
		selector.handleInput("\x12");
		expect(onSelect).not.toHaveBeenCalled();
		expect(harness.settingsManager.getDefaultModel()).not.toBe("other-model");

		selector.handleInput("\r");
		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onSelect.mock.calls[0]?.[0]?.id).toBe("other-model");
		expect(harness.settingsManager.getDefaultProvider()).toBe(currentModel.provider);
		expect(harness.settingsManager.getDefaultModel()).toBe("other-model");
	});

	it("lists every catalog that failed to refresh", async () => {
		harness = await createHarness();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map([
				["openai", new Error("unavailable")],
				["anthropic", new Error("unavailable")],
			]),
		});

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Could not refresh 2 model catalogs (openai, anthropic); showing cached models.");
		});
	});
});
