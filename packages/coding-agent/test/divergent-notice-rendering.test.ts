import type { Model } from "@earendil-works/pi-ai";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import promptUrlWidgetExtension from "../src/core/extensions/builtin/prompt-url-widget.ts";
import { renderBannerLines } from "../src/core/extensions/builtin/rules/ui/rules-banner.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { buildNoticeBox, noticeEntryRenderer, noticeMessageRenderer } from "../src/index.ts";
import { EarendilAnnouncementComponent } from "../src/modes/interactive/components/earendil-announcement.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, type Theme, theme } from "../src/modes/interactive/theme/theme.ts";

function renderComponent(component: Component, width = 160): string {
	return component.render(width).join("\n");
}

function renderChildren(container: { children: Component[] }, width = 160): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

const BOLD = "\x1b[1m";

function expectNoticeContract(rendered: string): void {
	expect(rendered).toContain(theme.getBgAnsi("customMessageBg"));
	expect(rendered).toContain(BOLD);
}

function interactiveMethod(name: string): (this: unknown, ...args: unknown[]) => void {
	const method = Reflect.get(InteractiveMode.prototype, name);
	if (typeof method !== "function") throw new Error(`InteractiveMode.${name} is missing`);
	return method;
}

function createInteractiveThis() {
	const chatContainer = new (class {
		children: Component[] = [];
		addChild(child: Component): void {
			this.children.push(child);
		}
	})();
	const fakeThis = {
		chatContainer,
		toolOutputExpanded: false,
		ui: {
			requestRender: vi.fn(),
			render: () => [],
			terminal: { columns: 120, rows: 40 },
		},
		session: { messages: [] },
		showNoticeBox(spec: unknown): void {
			interactiveMethod("showNoticeBox").call(fakeThis, spec);
		},
	};
	return fakeThis;
}

function riskyModel(): Model<"openai-completions"> {
	return {
		id: "minimax-m2",
		name: "MiniMax M2",
		api: "openai-completions",
		provider: "minimax",
		baseUrl: "http://127.0.0.1/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

describe("divergent notice rendering", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("exports the shared notice renderer primitives", () => {
		expect(buildNoticeBox).toBeTypeOf("function");
		expect(noticeMessageRenderer).toBeTypeOf("function");
		expect(noticeEntryRenderer).toBeTypeOf("function");
	});

	test.each([
		["showNewVersionNotification", ["2026.8.20"]],
		["showRiskyMainModelWarning", [riskyModel()]],
		["showHighReasoningWarning", [{ modelId: "gpt-5.6-sol", provider: "openai", thinkingLevel: "xhigh" }]],
		["showPackageUpdateNotification", [["example-extension@2.0.0"]]],
	])("renders %s through the notice background", (methodName, args) => {
		const fakeThis = createInteractiveThis();
		interactiveMethod(methodName).call(fakeThis, ...args);
		expectNoticeContract(renderChildren(fakeThis.chatContainer));
	});

	test("renders loaded-resource conflict diagnostics through the notice background", () => {
		const loadedResourcesContainer = new (class {
			children: Component[] = [];
			clear(): void {
				this.children = [];
			}
			addChild(child: Component): void {
				this.children.push(child);
			}
		})();
		const fakeThis = {
			options: { verbose: false },
			toolOutputExpanded: false,
			loadedResourcesContainer,
			settingsManager: { getQuietStartup: () => true, getDisabledBuiltinExtensions: () => [] },
			sessionManager: { getCwd: () => "/tmp/project" },
			session: {
				promptTemplates: [],
				extensionRunner: {
					getCommandDiagnostics: () => [],
					getShortcutDiagnostics: () => [],
				},
				resourceLoader: {
					getPathMetadata: () => new Map(),
					getAgentsFiles: () => ({ agentsFiles: [] }),
					getSystemPromptSource: () => undefined,
					getAppendSystemPromptSources: () => [],
					getSkills: () => ({ skills: [], diagnostics: [{ type: "warning", message: "duplicate skill" }] }),
					getPrompts: () => ({ prompts: [], diagnostics: [] }),
					getExtensions: () => ({ extensions: [], errors: [], runtime: {} }),
					getThemes: () => ({ themes: [], diagnostics: [] }),
				},
			},
			formatDiagnostics: () => "duplicate skill",
			getBuiltInCommandConflictDiagnostics: () => [],
		};
		interactiveMethod("showLoadedResources").call(fakeThis, {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});
		expectNoticeContract(renderChildren(loadedResourcesContainer));
	});

	test("renders the rules banner through the notice background", () => {
		const rendered = renderBannerLines(
			{
				ruleCount: 1,
				diagnostics: [],
				topRules: [{ relativePath: "AGENTS.md", matchReason: "single-file" }],
			},
			theme,
			120,
		).join("\n");
		expectNoticeContract(rendered);
	});

	test("renders the prompt URL widget through the notice background", async () => {
		let beforeAgentStart: ((event: { prompt: string }, ctx: ExtensionContext) => unknown) | undefined;
		let widgetFactory: ((tui: TUI, theme: Theme) => Component) | undefined;
		const pi = {
			on: (event: string, handler: (event: { prompt: string }, ctx: ExtensionContext) => unknown) => {
				if (event === "before_agent_start") beforeAgentStart = handler;
			},
			exec: () => new Promise(() => {}),
			getSessionName: () => undefined,
			setSessionName: () => {},
		} as unknown as ExtensionAPI;
		promptUrlWidgetExtension(pi);
		const ctx = {
			hasUI: true,
			ui: {
				setWidget: (_key: string, content: unknown) => {
					if (typeof content === "function") widgetFactory = content as (tui: TUI, theme: Theme) => Component;
				},
			},
		} as unknown as ExtensionContext;
		await beforeAgentStart?.({ prompt: "Analyze GitHub issue(s): https://github.com/org/repo/issues/1" }, ctx);
		if (!widgetFactory) throw new Error("Prompt URL widget was not registered");
		expectNoticeContract(renderComponent(widgetFactory({} as TUI, theme)));
	});

	test("renders the Earendil announcement text through the notice background", () => {
		expectNoticeContract(renderComponent(new EarendilAnnouncementComponent()));
	});

	test("renders debug-log completion through the notice background", () => {
		const fakeThis = createInteractiveThis();
		interactiveMethod("handleDebugCommand").call(fakeThis);
		expectNoticeContract(renderChildren(fakeThis.chatContainer));
	});
});
