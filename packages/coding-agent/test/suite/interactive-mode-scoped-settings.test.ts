import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

type CapturedSettingsCallbacks = {
	onThinkingLevelChange(level: ThinkingLevel): void;
};

type SelectorFactory = (done: () => void) => {
	readonly component: unknown;
	readonly focus: unknown;
};

const settingsCapture = vi.hoisted((): { callbacks?: CapturedSettingsCallbacks } => ({}));

vi.mock("../../src/modes/interactive/components/settings-selector.ts", () => ({
	SettingsSelectorComponent: class {
		constructor(_config: unknown, callbacks: CapturedSettingsCallbacks) {
			settingsCapture.callbacks = callbacks;
		}

		getSettingsList(): this {
			return this;
		}
	},
}));

const model: Model<"openai-completions"> = {
	id: "global-model",
	name: "Global Model",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "http://127.0.0.1:18990/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
};

describe("InteractiveMode scoped-setting caller compatibility", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		settingsCapture.callbacks = undefined;
	});

	it("keeps direct UI model selection on the global-setting model setter", async () => {
		// Given: both model-setting APIs are observable on the active session.
		const setModel = vi.fn(async () => undefined);
		const setSessionModel = vi.fn(async () => undefined);
		const fakeThis = {
			session: { setModel, setSessionModel },
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
			showRiskyMainModelWarning: vi.fn(),
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
			checkDaxnutsEasterEgg: vi.fn(),
		};
		const selectModelFromUi = Reflect.get(InteractiveMode.prototype, "selectModelFromUi");
		if (typeof selectModelFromUi !== "function") throw new Error("InteractiveMode.selectModelFromUi is missing");

		// When: the interactive model selector applies a model.
		await selectModelFromUi.call(fakeThis, model);

		// Then: established interactive behavior still updates global defaults.
		expect(setModel).toHaveBeenCalledExactlyOnceWith(model);
		expect(setSessionModel).not.toHaveBeenCalled();
	});

	it("keeps the settings UI thinking selector on the global-setting setter", async () => {
		// Given: the settings selector is opened with both thinking-setting APIs observable.
		const setThinkingLevel = vi.fn();
		const setSessionThinkingLevel = vi.fn();
		const showSelector = vi.fn((create: SelectorFactory) => {
			create(() => undefined);
		});
		const fakeThis = {
			showSelector,
			hideThinkingBlock: false,
			session: {
				autoCompactionEnabled: true,
				steeringMode: "all",
				followUpMode: "all",
				thinkingLevel: "low",
				getAvailableThinkingLevels: () => ["off", "low", "high"],
				setThinkingLevel,
				setSessionThinkingLevel,
			},
			settingsManager: createSettingsManagerStub(),
			ui: { mode: "inline" },
			themeController: { getThemeSelection: () => "dark", getTerminalTheme: () => "dark" },
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
		};
		const showSettingsSelector = Reflect.get(InteractiveMode.prototype, "showSettingsSelector");
		if (typeof showSettingsSelector !== "function") {
			throw new Error("InteractiveMode.showSettingsSelector is missing");
		}

		// When: the interactive settings callback selects a new thinking level.
		// showSettingsSelector is async: it awaits the (possibly remote) thinking-level
		// list before building the selector.
		await showSettingsSelector.call(fakeThis);
		const callbacks = settingsCapture.callbacks;
		if (callbacks === undefined) throw new Error("Settings callbacks were not captured");
		callbacks.onThinkingLevelChange("high");

		// Then: established interactive behavior still updates the global default.
		expect(setThinkingLevel).toHaveBeenCalledExactlyOnceWith("high");
		expect(setSessionThinkingLevel).not.toHaveBeenCalled();
	});

	it("keeps post-auth default model selection on the global-setting setter", async () => {
		// Given: authentication completes while the session still has the unknown placeholder model.
		const defaultModel = { provider: "openai", id: "gpt-5.6-sol" };
		const setModel = vi.fn(async () => undefined);
		const setSessionModel = vi.fn(async () => undefined);
		const fakeThis = {
			session: {
				modelRuntime: {
					getAvailableSnapshot: vi.fn(() => [defaultModel]),
					refresh: async () => ({ aborted: false, errors: new Map() }),
				},
				setModel,
				setSessionModel,
			},
			updateAvailableProviderCount: vi.fn(async () => undefined),
			ui: { requestRender: vi.fn() },
			footer: { invalidate: vi.fn() },
			showWarning: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
			showRiskyMainModelWarning: vi.fn(),
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
			checkDaxnutsEasterEgg: vi.fn(),
		};
		const completeProviderAuthentication = Reflect.get(InteractiveMode.prototype, "completeProviderAuthentication");
		if (typeof completeProviderAuthentication !== "function") {
			throw new Error("InteractiveMode.completeProviderAuthentication is missing");
		}

		// When: the interactive auth flow selects the provider's default model.
		await completeProviderAuthentication.call(fakeThis, "openai", "OpenAI", "api_key", {
			provider: "unknown",
			id: "unknown",
			api: "unknown",
		});

		// Then: this existing caller retains its global-default side effect.
		expect(setModel).toHaveBeenCalledExactlyOnceWith(defaultModel);
		expect(setSessionModel).not.toHaveBeenCalled();
	});

	it("refreshes message timestamps before rebuilding the transcript during reload", async () => {
		// Given: reload changes the persisted timestamp setting from disabled to enabled.
		const events: string[] = [];
		let fakeThis: { showMessageTimestamps: boolean } & Record<string, unknown>;
		fakeThis = {
			showMessageTimestamps: false,
			hideThinkingBlock: false,
			outputPad: 1,
			editor: {},
			editorContainer: new Container(),
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			settingsManager: {
				getHideThinkingBlock: () => false,
				getShowMessageTimestamps: () => true,
				getOutputPad: () => 1,
			},
			session: {
				isStreaming: false,
				isCompacting: false,
				checkReloadVeto: async () => ({ cancelled: false }),
				reload: async (options?: { beforeSessionStart?: () => void }) => {
					events.push("reload");
					options?.beforeSessionStart?.();
					events.push(`start:${fakeThis.showMessageTimestamps}`);
					throw new Error("stop after reload boundary");
				},
			},
			resetExtensionUI: vi.fn(),
			rebuildChatFromMessages: () => {
				events.push(`rebuild:${fakeThis.showMessageTimestamps}`);
			},
			showWarning: vi.fn(),
			showError: vi.fn(),
		};
		const handleReloadCommand = Reflect.get(InteractiveMode.prototype, "handleReloadCommand");
		if (typeof handleReloadCommand !== "function") {
			throw new Error("InteractiveMode.handleReloadCommand is missing");
		}

		// When: the interactive reload reaches its before-session-start reconstruction boundary.
		await handleReloadCommand.call(fakeThis);

		// Then: the refreshed value is visible to both transcript rebuild and session start.
		expect(fakeThis.showMessageTimestamps).toBe(true);
		expect(events).toEqual(["reload", "rebuild:true", "start:true"]);
	});
});

function createSettingsManagerStub() {
	return {
		getShowImages: () => false,
		getImageWidthCells: () => 80,
		getImageAutoResize: () => true,
		getBlockImages: () => false,
		getEnableSkillCommands: () => true,
		getTransport: () => "auto",
		getHttpIdleTimeoutMs: () => 300_000,
		getThemeSetting: () => "dark",
		getCollapseChangelog: () => false,
		getEnableInstallTelemetry: () => false,
		getDoubleEscapeAction: () => "tree",
		getTreeFilterMode: () => "default",
		getShowHardwareCursor: () => true,
		getShowCacheMissNotices: () => true,
		getDefaultProjectTrust: () => "ask",
		getEditorPaddingX: () => 0,
		getOutputPad: () => 0,
		getAutocompleteMaxVisible: () => 10,
		getQuietStartup: () => false,
		getClearOnShrink: () => false,
		getShowTerminalProgress: () => false,
		getTuiMode: () => "regular",
		getFullscreenExitOutput: () => "transcript",
		getFullscreenScrollbar: () => "auto",
		getSmoothStreaming: () => false,
		getSmoothStreamingFps: () => 30,
		getMermaidRenderingMode: () => "streaming",
		getWarnings: () => ({}),
	};
}
