import { Container, setCapabilities, TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { ReadonlyFooterDataProvider } from "../../src/core/footer-data-provider.ts";
import { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";
import { FooterComponent } from "../../src/modes/interactive/components/footer.ts";
import { WorkingStatusIndicator } from "../../src/modes/interactive/components/status-indicator.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { getResolvedThemeColors, initTheme } from "../../src/modes/interactive/theme/theme.ts";

type HeaderFixture = {
	isInitialized: boolean;
	registerSignalHandlers(): void;
	resumeQuestionMouseCapture(): void;
	getChangelogForDisplay(): undefined;
	fdPath: string | undefined;
	session: { scopedModels: unknown[]; releaseSettledSessionMemory(): void };
	options: { verbose: boolean };
	settingsManager: {
		getQuietStartup(): boolean;
		getTipsEnabled(): boolean;
		getTipsHistory(): Record<string, number>;
		getFullscreenScrollbar(): "auto";
		setTipShown(tipId: string, timestamp: number): void;
	};
	keybindings: unknown;
	ui: Container & {
		setFocus(): void;
		start(): void;
		requestRender(): void;
	};
	renderer: Container;
	headerContainer: Container;
	loadedResourcesContainer: Container;
	chatContainer: Container;
	documentContainer: Container;
	pendingMessagesContainer: Container;
	statusContainer: Container;
	hookStatusContainer: Container;
	widgetContainerAbove: Container;
	editorContainer: Container;
	widgetContainerBelow: Container;
	footer: Container;
	footerContainer: Container;
	editor: Container;
	renderWidgets(): void;
	mountInteractiveTui(renderer: Container, components: readonly Container[]): void;
	setupKeyHandlers(): void;
	setupEditorSubmitHandler(): void;
	themeController: { applyFromSettings(): void; waitForTerminalColors(): Promise<void> };
	version: string;
	getStartupExpansionState(): boolean;
	rebindCurrentSession(): Promise<void>;
	renderInitialMessages(): void;
	updateEditorBorderColor(): void;
	footerDataProvider: { onBranchChange(): void };
	updateAvailableProviderCount(): Promise<void>;
};

type BorderFixture = {
	isBashMode: boolean;
	session: { thinkingLevel: "off" };
	editor: { borderColor: (text: string) => string };
	ui: { requestRender(): void };
};

type BorderMethod = (this: BorderFixture) => void;

const RAW = (value: string) => value;
// D-14 adopted the upstream OKHSL dark palette, so the classic chrome is pinned by the dark theme token
// each byte is painted with (layout and token routing), not by the pre-sync RGB literals.
const tokenRgb = (token: string): string => {
	const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/.exec(getResolvedThemeColors("dark")[token] ?? "");
	if (!match) throw new Error(`dark theme token ${token} has no resolved hex color`);
	return match
		.slice(1)
		.map((channel) => parseInt(channel, 16))
		.join(";");
};
const fg = (rgb: string, text: string) => `\x1b[38;2;${rgb}m${text}\x1b[39m`;
const bg = (rgb: string, text: string) => `\x1b[48;2;${rgb}m${text}\x1b[49m`;
const line = (text: string, width: number) => `${text}${" ".repeat(width - visibleWidth(text))}`;

function createHeaderFixture(): HeaderFixture {
	const ui = new Container() as HeaderFixture["ui"];
	ui.setFocus = () => {};
	ui.start = () => {};
	ui.requestRender = () => {};
	const headerContainer = new Container();
	const loadedResourcesContainer = new Container();
	const chatContainer = new Container();
	const documentContainer = new Container();
	documentContainer.addChild(headerContainer);
	documentContainer.addChild(loadedResourcesContainer);
	documentContainer.addChild(chatContainer);
	return {
		isInitialized: false,
		registerSignalHandlers: () => {},
		resumeQuestionMouseCapture: () => {},
		getChangelogForDisplay: () => undefined,
		fdPath: undefined,
		session: { scopedModels: [], releaseSettledSessionMemory: () => {} },
		options: { verbose: true },
		settingsManager: {
			getQuietStartup: () => false,
			getTipsEnabled: () => false,
			getTipsHistory: () => ({}),
			getFullscreenScrollbar: () => "auto",
			setTipShown: () => {},
		},
		keybindings: {},
		ui,
		renderer: ui,
		headerContainer,
		loadedResourcesContainer,
		chatContainer,
		documentContainer,
		pendingMessagesContainer: new Container(),
		statusContainer: new Container(),
		hookStatusContainer: new Container(),
		widgetContainerAbove: new Container(),
		editorContainer: new Container(),
		widgetContainerBelow: new Container(),
		footer: new Container(),
		footerContainer: new Container(),
		editor: new Container(),
		renderWidgets: () => {},
		mountInteractiveTui: (renderer, components) => {
			for (const component of components) renderer.addChild(component);
		},
		setupKeyHandlers: () => {},
		setupEditorSubmitHandler: () => {},
		themeController: { applyFromSettings: () => {}, waitForTerminalColors: async () => {} },
		version: "9.9.9",
		getStartupExpansionState: () => false,
		rebindCurrentSession: async () => {},
		renderInitialMessages: () => {},
		updateEditorBorderColor: () => {},
		footerDataProvider: { onBranchChange: () => {} },
		updateAvailableProviderCount: async () => {},
	};
}

function createClassicRuntime(): AgentSessionRuntime {
	return {
		session: {
			autoCompactionEnabled: true,
			resourceLoader: { getThemes: () => ({ themes: [] }) },
			sessionManager: { getCwd: () => process.cwd() },
			settingsManager: {
				getAutocompleteMaxVisible: () => 5,
				getClearOnShrink: () => false,
				getEditorPaddingX: () => 0,
				getHideThinkingBlock: () => false,
				getOutputPad: () => 1,
				getPackages: () => [],
				getShowHardwareCursor: () => false,
				getTuiMode: () => "regular",
				getSmoothStreaming: () => false,
				getSmoothStreamingFps: () => 60,
				getThemeSetting: () => "dark",
			},
		},
		setBeforeSessionInvalidate: () => {},
		setRebindSession: () => {},
	} as unknown as AgentSessionRuntime;
}

function createFooterSession(): AgentSession {
	return {
		state: {
			model: { id: "faux-1", provider: "faux", contextWindow: 200_000, reasoning: false },
			thinkingLevel: "off",
		},
		sessionManager: {
			getUsageTotals: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }),
			getSessionName: () => undefined,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		isFastModeActive: () => false,
		modelRuntime: {
			isUsingOAuth: () => false,
			isUsingSubscription: () => false,
		},
	} as unknown as AgentSession;
}

const footerData: ReadonlyFooterDataProvider = {
	getGitBranch: () => null,
	getExtensionStatuses: () => new Map(),
	getAvailableProviderCount: () => 0,
	onBranchChange: () => () => {},
};

beforeEach(() => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	initTheme("dark", false);
});

afterEach(() => {
	initTheme("dark", false);
});

describe("classic chrome characterization", () => {
	it("keeps the built-in welcome/header block byte-identical", async () => {
		const fixture = createHeaderFixture();
		const init = InteractiveMode.prototype.init as unknown as (this: HeaderFixture) => Promise<void>;
		await init.call(fixture);

		const rendered = fixture.headerContainer.render(120).join("\n");
		const muted = tokenRgb("muted");
		const dim = tokenRgb("dim");
		const compactInstructions = [
			fg(dim, "") + fg(muted, " interrupt"),
			fg(dim, "/") + fg(muted, " clear/exit"),
			fg(dim, "/") + fg(muted, " commands"),
			fg(dim, "!") + fg(muted, " bash"),
			fg(dim, "") + fg(muted, " more"),
		].join(fg(muted, " · "));
		const expected = [
			"",
			line(` ${fg(tokenRgb("accent"), "senpi")}${fg(dim, " v9.9.9")}`, 120),
			line(` ${compactInstructions}`, 120),
			line(` ${fg(dim, "Press  to show full startup help and loaded resources.")}`, 120),
			line("", 120),
			line(
				` ${fg(dim, "Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.")}`,
				120,
			),
			"",
		].join("\n");
		expect(rendered).toBe(expected);
	});

	it("keeps the classic root child ordering byte-identical", async () => {
		const fixture = createHeaderFixture();
		const init = InteractiveMode.prototype.init as unknown as (this: HeaderFixture) => Promise<void>;
		await init.call(fixture);

		expect(fixture.ui.children).toEqual([
			fixture.documentContainer,
			fixture.pendingMessagesContainer,
			fixture.statusContainer,
			fixture.hookStatusContainer,
			fixture.widgetContainerAbove,
			fixture.editorContainer,
			fixture.widgetContainerBelow,
			fixture.footerContainer,
		]);
	});

	it("keeps the classic base editor construction byte-identical", () => {
		const mode = new InteractiveMode(createClassicRuntime());
		const editor = (mode as unknown as { defaultEditor: CustomEditor }).defaultEditor;

		expect(editor).toBeInstanceOf(CustomEditor);
		expect(editor.getPaddingX()).toBe(0);
		expect(editor.borderColor("─")).toBe(fg(tokenRgb("borderMuted"), "─"));
	});

	it("keeps the built-in footer byte-identical", () => {
		const footer = new FooterComponent(createFooterSession(), footerData);
		const rendered = footer.render(80).join("\n");
		const expected =
			fg(tokenRgb("accent"), "/tmp/project") +
			fg(tokenRgb("borderMuted"), " • ") +
			fg(tokenRgb("muted"), "25K/200K (12.3%) (auto)") +
			" ".repeat(36) +
			fg(tokenRgb("accent"), "faux-1");
		expect(rendered).toBe(expected);
	});

	it("keeps a tool-execution row byte-identical", () => {
		const ui = new TUI(new VirtualTerminal(80, 24));
		const component = new ToolExecutionComponent(
			"classic_characterization",
			"call-1",
			{ value: "x" },
			{},
			undefined,
			ui,
			"/tmp",
		);
		try {
			const rendered = component.render(80).join("\n");
			const pending = tokenRgb("toolPendingBg");
			const expected = [
				"",
				bg(pending, line("", 80)),
				bg(pending, line(` ${fg(tokenRgb("toolTitle"), "classic_characterization")}`, 80)),
				bg(pending, line("", 80)),
				bg(pending, line(" {", 80)),
				bg(pending, line('   "value": "x"', 80)),
				bg(pending, line(" }", 80)),
				bg(pending, line("", 80)),
			].join("\n");
			expect(rendered).toBe(expected);
		} finally {
			component.dispose();
		}
	});

	it("keeps the working indicator byte-identical", () => {
		const ui = new TUI(new VirtualTerminal(80, 24));
		const indicator = new WorkingStatusIndicator(ui, "Working");
		try {
			const rendered = indicator.render(80).join("\n");
			expect(rendered).toBe(`\n${line(` ${fg(tokenRgb("accent"), "⠋")} ${fg(tokenRgb("muted"), "Working")}`, 80)}`);
		} finally {
			indicator.dispose();
		}
	});

	it("keeps the editor thinking border colour byte-identical", () => {
		const fixture: BorderFixture = {
			isBashMode: false,
			session: { thinkingLevel: "off" },
			editor: { borderColor: RAW },
			ui: { requestRender: () => {} },
		};
		const updateEditorBorderColor = (
			InteractiveMode.prototype as unknown as { updateEditorBorderColor: BorderMethod }
		).updateEditorBorderColor;
		updateEditorBorderColor.call(fixture);
		const rendered = fixture.editor.borderColor("─");
		expect(rendered).toBe(fg(tokenRgb("thinkingOff"), "─"));
	});
});
