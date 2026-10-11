import type { Model } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelBlacklistAdapter, ModelBlacklistState } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function renderSignal(tui: TUI, predicate: () => boolean): Promise<void> {
	return new Promise((resolve, reject) => {
		const previous = tui.requestRender.bind(tui);
		const timer = setTimeout(() => {
			tui.requestRender = previous;
			reject(new Error("Expected picker render did not arrive"));
		}, 3000);
		tui.requestRender = () => {
			previous();
			if (!predicate()) return;
			clearTimeout(timer);
			tui.requestRender = previous;
			resolve();
		};
	});
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

	// #2327: models available only through ambient cloud credentials (AWS env, Google ADC) stay
	// listed but never lead the list ahead of providers the user configured.
	it("lists ambient-only providers after configured providers", async () => {
		harness = await createHarness({
			models: [{ id: "configured-model", name: "Configured Model", reasoning: true }],
		});
		const runtime = harness.session.modelRuntime;
		const tui = createFakeTui();
		const configured = harness.getModel("configured-model")!;
		const cloud = { ...configured, provider: "amazon-bedrock", id: "cloud-model", name: "Cloud Model" };
		vi.spyOn(runtime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
		vi.spyOn(runtime, "getAvailableSnapshot").mockReturnValue([cloud, configured]);
		const actualStatus = runtime.getProviderAuthStatus.bind(runtime);
		vi.spyOn(runtime, "getProviderAuthStatus").mockImplementation((provider) =>
			provider === "amazon-bedrock"
				? { configured: true, source: "environment", label: "AWS access keys", ambient: true }
				: actualStatus(provider),
		);
		const selector = new ModelSelectorComponent(
			tui,
			undefined,
			harness.settingsManager,
			runtime,
			[],
			() => {},
			() => {},
		);

		const listedIds = stripAnsi(selector.render(120).join("\n"))
			.split("\n")
			.flatMap((line) => /(\S+-model) \[/.exec(line)?.[1] ?? []);
		expect(listedIds).toEqual(["configured-model", "cloud-model"]);
		selector.dispose();
	});

	// Upstream #9149 made the selector's separate "set as default" chord follow app.models.save.
	// The fork has no separate chord: confirming a model already persists it as the default, so a
	// rebound app.models.save must neither select nor save here, while confirm still does both.
	it("applies a selection to the session on confirm, and Ctrl+S no longer saves once the save chord is rebound", async () => {
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
		const defaultBefore = harness.settingsManager.getDefaultModel();

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("select as default");
		selector.handleInput("\x1b[B");
		selector.handleInput("\x13");
		expect(onSelect).not.toHaveBeenCalled();

		selector.handleInput("\r");
		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onSelect.mock.calls[0]?.[0]?.id).toBe("other-model");
		expect(onSelect.mock.calls[0]?.[1]).toEqual({ asDefault: false });
		// senpi#2870: the selector itself never writes the default for new sessions.
		expect(harness.settingsManager.getDefaultModel()).toBe(defaultBefore);
	});

	it("passes asDefault for the save chord (Ctrl+S by default), which makes the selection the default", async () => {
		setKeybindings(new KeybindingsManager({}));
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "other-model", name: "Other Model", reasoning: true },
			],
		});
		const onSelect = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("current-model")!,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			onSelect,
			() => {},
		);

		selector.handleInput("\x1b[B");
		selector.handleInput("\x13");

		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onSelect.mock.calls[0]?.[0]?.id).toBe("other-model");
		expect(onSelect.mock.calls[0]?.[1]).toEqual({ asDefault: true });
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

	// Background refresh used to snap the highlight back to the current model while the user browsed.
	it("keeps the highlighted row when the background refresh finishes", async () => {
		harness = await createHarness({
			models: [
				{ id: "alpha-model", name: "Alpha Model", reasoning: true },
				{ id: "beta-model", name: "Beta Model", reasoning: true },
			],
		});
		const runtime = harness.session.modelRuntime;
		let finishRefresh: (result: { aborted: boolean; errors: Map<string, Error> }) => void = () => {};
		const tui = createFakeTui();
		vi.spyOn(runtime, "refresh").mockReturnValue(
			new Promise((resolve) => {
				finishRefresh = resolve;
			}),
		);
		const selector = new ModelSelectorComponent(
			tui,
			harness.getModel("alpha-model"),
			harness.settingsManager,
			runtime,
			[],
			() => {},
			() => {},
		);

		selector.handleInput("\x1b[B");
		const refreshed = renderSignal(tui, () => renderedText(selector).includes("Model catalogs refreshed."));
		finishRefresh({ aborted: false, errors: new Map() });
		await refreshed;
		expect(modelRow(selector, "beta-model")?.startsWith("→")).toBe(true);
		expect(modelRow(selector, "alpha-model")?.startsWith("→")).toBe(false);
		selector.dispose();
	});
});

function renderedText(selector: ModelSelectorComponent): string {
	return stripAnsi(selector.render(140).join("\n"));
}

function modelRow(selector: ModelSelectorComponent, id: string): string | undefined {
	return renderedText(selector)
		.split("\n")
		.find((line) => line.includes(`${id} [`))
		?.trim();
}

describe("model picker blacklist (Ctrl+Alt+B)", () => {
	const CTRL_B = "\x1b\x02";
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

	const fullId = (model: Model<any>): string => `${model.provider}/${model.id}`;

	// A policy double with the real adapter contract: toggle flips the saved state only, the active state
	// stays whatever the process started with.
	function createBlacklist(
		models: Model<any>[],
		initial: Record<string, ModelBlacklistState>,
		beforeSave?: (model: Model<any>) => void | Promise<void>,
	) {
		const states = new Map(Object.entries(initial));
		const toggled: string[] = [];
		const adapter: ModelBlacklistAdapter = {
			getModels: () => models,
			getState: (model) => states.get(fullId(model)) ?? { blocked: false, activeBlocked: false },
			toggle: async (model) => {
				toggled.push(fullId(model));
				await beforeSave?.(model);
				const state = states.get(fullId(model)) ?? { blocked: false, activeBlocked: false };
				states.set(fullId(model), { ...state, blocked: !state.blocked });
			},
		};
		return { adapter, toggled };
	}

	async function openPicker(options: {
		blacklist?: ModelBlacklistAdapter;
		onSelect?: () => void;
	}): Promise<{ selector: ModelSelectorComponent; alpha: Model<any>; tui: TUI }> {
		harness = await createHarness({
			models: [
				{ id: "alpha-model", name: "Alpha Model", reasoning: true },
				{ id: "beta-model", name: "Beta Model", reasoning: true },
			],
		});
		const alpha = harness.getModel("alpha-model")!;
		const tui = createFakeTui();
		const selector = new ModelSelectorComponent(
			tui,
			alpha,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			options.onSelect ?? (() => {}),
			() => {},
			undefined,
			undefined,
			options.blacklist,
		);
		return { selector, alpha, tui };
	}

	it("offers no blacklist key when no extension installed an adapter", async () => {
		const { selector } = await openPicker({});

		expect(renderedText(selector)).not.toContain("block/unblock");
		selector.dispose();
	});

	it("lists blocked models the runtime never loaded, keeps them searchable, and refuses to select them", async () => {
		const onSelect = vi.fn();
		harness = await createHarness({ models: [{ id: "alpha-model", name: "Alpha Model", reasoning: true }] });
		const alpha = harness.getModel("alpha-model")!;
		const zeta = { ...alpha, id: "zeta-blocked", name: "Zeta Blocked" };
		const { adapter } = createBlacklist([zeta], { [fullId(zeta)]: { blocked: true, activeBlocked: true } });
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			alpha,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			onSelect,
			() => {},
			undefined,
			undefined,
			adapter,
		);

		expect(renderedText(selector)).toContain("block/unblock");
		expect(modelRow(selector, "zeta-blocked")).toMatch(/\[.*\] blocked$/);
		for (const char of "zeta") selector.handleInput(char);
		expect(modelRow(selector, "zeta-blocked")?.startsWith("→")).toBe(true);
		selector.handleInput("\r");

		expect(onSelect).not.toHaveBeenCalled();
		expect(renderedText(selector)).toContain(`${fullId(zeta)} is blocked when senpi started and cannot be selected`);
		selector.dispose();
	});

	it("uses Ctrl+Alt+B without claiming Herdr's Ctrl+B prefix", async () => {
		const { adapter, toggled } = createBlacklist([], {});
		const { selector, alpha, tui } = await openPicker({ blacklist: adapter });
		const modifier = process.platform === "darwin" ? "option" : "alt";
		expect(renderedText(selector)).toContain(`ctrl+f favorite ctrl+${modifier}+b block/unblock`);
		selector.handleInput("\x02");
		expect(toggled).toEqual([]);
		const saved = renderSignal(tui, () => renderedText(selector).includes(`Saved ${fullId(alpha)} as blocked.`));
		selector.handleInput(CTRL_B);
		await saved;
		expect(toggled).toEqual([fullId(alpha)]);
		selector.dispose();
	});

	it("prefers the runtime's own copy of a model the adapter also lists", async () => {
		const { adapter } = createBlacklist([], {});
		const { selector, alpha } = await openPicker({ blacklist: adapter });
		const staleAlpha = { ...alpha, name: "Stale Alpha" };
		adapter.getModels = () => [staleAlpha];
		const reopened = new ModelSelectorComponent(
			createFakeTui(),
			alpha,
			harness!.settingsManager,
			harness!.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			undefined,
			adapter,
		);

		const text = renderedText(reopened);
		expect(text).toContain("Model Name: Alpha Model");
		expect(text).not.toContain("Stale Alpha");
		expect(text.match(/alpha-model \[/g)).toHaveLength(1);
		selector.dispose();
		reopened.dispose();
	});

	it("shows the pending save, ignores a second toggle, and keeps the highlight where the user moved", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { adapter, toggled } = createBlacklist([], {}, () => gate);
		const { selector, alpha, tui } = await openPicker({ blacklist: adapter });

		selector.handleInput(CTRL_B);
		selector.handleInput(CTRL_B);
		expect(toggled).toEqual([fullId(alpha)]);
		expect(modelRow(selector, "alpha-model")).toContain("saving");
		expect(renderedText(selector)).toContain(`Saving blacklist change for ${fullId(alpha)}`);

		selector.handleInput("\x1b[B");
		const saved = renderSignal(tui, () => renderedText(selector).includes(`Saved ${fullId(alpha)} as blocked.`));
		release();
		await saved;

		expect(renderedText(selector)).toContain("Restart senpi to apply it; this process keeps its current models.");
		expect(modelRow(selector, "alpha-model")).toContain("blocked (restart required)");
		expect(modelRow(selector, "beta-model")?.startsWith("→")).toBe(true);
		selector.dispose();
	});

	it("reports a failed save and leaves the saved state alone", async () => {
		const { adapter } = createBlacklist([], {}, () => {
			throw new Error("disk full");
		});
		const { selector, alpha, tui } = await openPicker({ blacklist: adapter });

		const failed = renderSignal(tui, () =>
			renderedText(selector).includes(`Could not save blacklist change for ${fullId(alpha)}: disk full`),
		);
		selector.handleInput(CTRL_B);
		await failed;
		expect(modelRow(selector, "alpha-model")).not.toMatch(/blocked|saving/);
		selector.dispose();
	});

	it("follows a rebound toggleBlacklist chord", async () => {
		setKeybindings(new KeybindingsManager({ "app.models.toggleBlacklist": "ctrl+u" }));
		const { adapter, toggled } = createBlacklist([], {});
		const { selector, alpha, tui } = await openPicker({ blacklist: adapter });

		selector.handleInput(CTRL_B);
		expect(toggled).toEqual([]);
		const saved = renderSignal(tui, () => renderedText(selector).includes(`Saved ${fullId(alpha)} as blocked.`));
		selector.handleInput("\x15");

		expect(toggled).toEqual([fullId(alpha)]);
		await saved;
		selector.dispose();
	});

	// Boundary: an extension's ctx.ui.setModelBlacklist reaches the picker /model opens.
	it("installs the adapter through the interactive UI context into the picker", async () => {
		harness = await createHarness({ models: [{ id: "alpha-model", name: "Alpha Model", reasoning: true }] });
		const alpha = harness.getModel("alpha-model")!;
		const zeta = { ...alpha, id: "zeta-blocked", name: "Zeta Blocked" };
		const eta = { ...alpha, id: "eta-extension", name: "Eta Extension" };
		const { adapter } = createBlacklist([eta], { [fullId(eta)]: { blocked: true, activeBlocked: true } });
		const { adapter: nativeAdapter } = createBlacklist([zeta], {
			[fullId(zeta)]: { blocked: true, activeBlocked: true },
		});
		vi.spyOn(harness.session.modelRuntime, "getModelBlacklistAdapter").mockReturnValue(nativeAdapter);
		const fakeThis: any = {
			session: { favoriteModels: [], model: alpha, modelRuntime: harness.session.modelRuntime, scopedModels: [] },
			settingsManager: harness.settingsManager,
			ui: createFakeTui(),
			captureFavoritePatternSnapshot: vi.fn(async () => undefined),
			showSelector: vi.fn(),
		};
		const prototype = InteractiveMode.prototype as any;
		const uiContext = prototype.createExtensionUIContext.call(fakeThis);
		const openFromCommand = (): ModelSelectorComponent => {
			prototype.showModelSelector.call(fakeThis);
			const factory = fakeThis.showSelector.mock.calls.at(-1)[0];
			return factory(() => {}).component;
		};

		const nativePicker = openFromCommand();
		expect(modelRow(nativePicker, "zeta-blocked")).toMatch(/blocked$/);
		expect(modelRow(nativePicker, "eta-extension")).toBeUndefined();
		nativePicker.dispose();

		uiContext.setModelBlacklist(adapter);
		const withAdapter = openFromCommand();
		expect(renderedText(withAdapter)).toContain("block/unblock");
		expect(modelRow(withAdapter, "eta-extension")).toMatch(/blocked$/);
		expect(modelRow(withAdapter, "zeta-blocked")).toBeUndefined();
		withAdapter.dispose();

		uiContext.setModelBlacklist(undefined);
		const withoutAdapter = openFromCommand();
		expect(renderedText(withoutAdapter)).toContain("block/unblock");
		expect(modelRow(withoutAdapter, "zeta-blocked")).toMatch(/blocked$/);
		expect(modelRow(withoutAdapter, "eta-extension")).toBeUndefined();
		withoutAdapter.dispose();
	});
});
