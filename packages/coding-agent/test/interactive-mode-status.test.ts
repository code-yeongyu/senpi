import os, { homedir } from "node:os";
import * as path from "node:path";
import {
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	resetCapabilitiesCache,
	setCapabilities,
	setKeybindings,
} from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { type Component, Container, type Focusable, TUI } from "../../tui/src/tui.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { APP_TITLE } from "../src/config.ts";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { AutocompleteProviderFactory } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SourceInfo } from "../src/core/source-info.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function renderLastLine(container: Container, width = 120): string {
	const last = container.children[container.children.length - 1];
	if (!last) return "";
	return last.render(width).join("\n");
}

function renderAll(container: Container, width = 120): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

class TestFocusableComponent implements Component, Focusable {
	focused = false;
	inputs: string[] = [];
	private readonly label: string;
	private text = "";

	constructor(label: string) {
		this.label = label;
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
	}

	render(): string[] {
		return [this.label];
	}

	invalidate(): void {}
}

async function flushTui(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await Promise.resolve();
	await terminal.waitForRender();
}

function normalizeRenderedOutput(container: Container, width = 220): string {
	return renderAll(container, width)
		.replace(/\u001b\[[0-9;]*m/g, "")
		.replace(/\\/g, "/")
		.split("\n")
		.map((line) => line.replace(/\s+$/g, ""))
		.join("\n")
		.trim();
}

type ExtensionFixture = {
	path: string;
	sourceInfo?: SourceInfo;
};

type ToolHookStatusEvent = Extract<AgentSessionEvent, { type: "tool_hook_status" }>;
type UnsafeToolHookStatusStartEvent = Omit<Extract<ToolHookStatusEvent, { phase: "start" }>, "hookName"> & {
	readonly hookName: string;
};
type TerminalTitleToolHookStatusEvent = ToolHookStatusEvent | UnsafeToolHookStatusStartEvent;
type ToolExecutionStartEvent = Extract<AgentSessionEvent, { type: "tool_execution_start" }>;
type ToolExecutionEndEvent = Extract<AgentSessionEvent, { type: "tool_execution_end" }>;

type TerminalTitlePrototype = {
	handleToolHookStatusEvent(this: TerminalTitleThis, event: TerminalTitleToolHookStatusEvent): void;
	refreshToolHookStatuses(this: TerminalTitleThis): void;
	applyTerminalTitle(this: TerminalTitleThis): void;
	updateTerminalTitle(this: TerminalTitleThis): void;
	getNormalTerminalTitle(this: TerminalTitleThis): string;
};

type TerminalTitleThis = {
	activeToolHooks: Map<string, Extract<ToolHookStatusEvent, { phase: "start" }>>;
	activeToolTerminalTitle: string | undefined;
	extensionTerminalTitle: string | undefined;
	hookStatusContainer: Container;
	sessionManager: {
		getCwd(): string;
		getSessionName(): string | undefined;
	};
	startToolHookStatusTimer(): void;
	stopToolHookStatusTimer(): void;
	refreshToolHookStatuses(): void;
	applyTerminalTitle(): void;
	updateTerminalTitle(): void;
	getNormalTerminalTitle(): string;
	ui: {
		requestRender(): void;
		terminal: {
			setTitle(title: string): void;
		};
	};
};

type ActiveToolLifecyclePrototype = TerminalTitlePrototype & {
	getWorkingLoaderMessage(this: ActiveToolLifecycleThis): string;
	handleEvent(this: ActiveToolLifecycleThis, event: ToolExecutionStartEvent | ToolExecutionEndEvent): Promise<void>;
	handleToolExecutionEnd(this: ActiveToolLifecycleThis, event: ToolExecutionEndEvent): void;
	handleToolExecutionStart(this: ActiveToolLifecycleThis, event: ToolExecutionStartEvent): void;
	refreshWorkingLoaderMessage(this: ActiveToolLifecycleThis): void;
};

type ActiveToolLifecycleThis = TerminalTitleThis & {
	activeToolExecutionTerminalTitle: string | undefined;
	activeToolExecutions: Map<string, string>;
	chatContainer: Container;
	defaultWorkingMessage: string;
	footer: {
		invalidate(): void;
	};
	getRegisteredToolDefinition(toolName: string): undefined;
	getWorkingLoaderMessage(): string;
	handleToolExecutionEnd(event: ToolExecutionEndEvent): void;
	handleToolExecutionStart(event: ToolExecutionStartEvent): void;
	isInitialized: boolean;
	loadingAnimation:
		| {
				setMessage(message: string): void;
		  }
		| undefined;
	pendingTools: Map<
		string,
		{
			markExecutionStarted(): void;
			updateResult(result: unknown): void;
		}
	>;
	refreshWorkingLoaderMessage(): void;
	requestStreamingRender(): void;
	session: {
		isStreaming: boolean;
	};
	settingsManager: {
		getImageWidthCells(): number;
		getShowImages(): boolean;
	};
	toolOutputExpanded: boolean;
	workingMessage: string | undefined;
	workingMessageBeforeActiveTool: string | undefined;
};

describe("InteractiveMode.showStatus", () => {
	beforeAll(() => {
		// showStatus uses the global theme instance
		initTheme("dark");
	});

	test("coalesces immediately-sequential status messages", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_ONE");

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// second status updates the previous line instead of appending
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
		expect(renderLastLine(fakeThis.chatContainer)).not.toContain("STATUS_ONE");
	});

	test("appends a new status line if something else was added in between", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);

		// Something else gets added to the chat in between status updates
		fakeThis.chatContainer.addChild({ render: () => ["OTHER"], invalidate: () => {} });
		expect(fakeThis.chatContainer.children).toHaveLength(3);

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// adds spacer + text
		expect(fakeThis.chatContainer.children).toHaveLength(5);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
	});
});

describe("InteractiveMode terminal title state", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("restores terminal title after active tool status", () => {
		// Given
		const prototype = InteractiveMode.prototype as unknown as TerminalTitlePrototype;
		const setTitle = vi.fn();
		const fakeThis: TerminalTitleThis = {
			activeToolHooks: new Map(),
			activeToolTerminalTitle: undefined,
			extensionTerminalTitle: undefined,
			hookStatusContainer: new Container(),
			sessionManager: {
				getCwd: () => "/tmp/senpi-project",
				getSessionName: () => "Visible Session",
			},
			startToolHookStatusTimer: vi.fn(),
			stopToolHookStatusTimer: vi.fn(),
			refreshToolHookStatuses: prototype.refreshToolHookStatuses,
			applyTerminalTitle: prototype.applyTerminalTitle,
			updateTerminalTitle: prototype.updateTerminalTitle,
			getNormalTerminalTitle: prototype.getNormalTerminalTitle,
			ui: {
				requestRender: vi.fn(),
				terminal: { setTitle },
			},
		};

		// When
		prototype.handleToolHookStatusEvent.call(fakeThis, {
			type: "tool_hook_status",
			phase: "start",
			hookRunId: "run-1",
			hookName: "PostToolUse",
			toolName: "bash",
			toolCallId: "call-1",
			extensionPath: "<builtin:comment-checker>",
			statusMessage: "checking generated comments",
			startedAt: Date.now(),
		});

		// Then
		expect(setTitle).toHaveBeenLastCalledWith(`${APP_TITLE} - PostToolUse: checking generated comments`);

		// When
		prototype.handleToolHookStatusEvent.call(fakeThis, {
			type: "tool_hook_status",
			phase: "end",
			hookRunId: "run-1",
			hookName: "PostToolUse",
			toolName: "bash",
			toolCallId: "call-1",
			extensionPath: "<builtin:comment-checker>",
			statusMessage: "checking generated comments",
			startedAt: Date.now(),
			completedAt: Date.now(),
			status: "completed",
		});

		// Then
		expect(setTitle).toHaveBeenLastCalledWith(`${APP_TITLE} - Visible Session - senpi-project`);
	});

	test("sanitizes active tool hook terminal title", () => {
		// Given
		const prototype = InteractiveMode.prototype as unknown as TerminalTitlePrototype;
		const setTitle = vi.fn();
		const fakeThis: TerminalTitleThis = {
			activeToolHooks: new Map(),
			activeToolTerminalTitle: undefined,
			extensionTerminalTitle: undefined,
			hookStatusContainer: new Container(),
			sessionManager: {
				getCwd: () => "/tmp/senpi-project",
				getSessionName: () => "Visible Session",
			},
			startToolHookStatusTimer: vi.fn(),
			stopToolHookStatusTimer: vi.fn(),
			refreshToolHookStatuses: prototype.refreshToolHookStatuses,
			applyTerminalTitle: prototype.applyTerminalTitle,
			updateTerminalTitle: prototype.updateTerminalTitle,
			getNormalTerminalTitle: prototype.getNormalTerminalTitle,
			ui: {
				requestRender: vi.fn(),
				terminal: { setTitle },
			},
		};

		// When
		prototype.handleToolHookStatusEvent.call(fakeThis, {
			type: "tool_hook_status",
			phase: "start",
			hookRunId: "run-hostile",
			hookName: "PostToolUse\x1b]2;owned\x07\nPreToolUse",
			toolName: "bash",
			toolCallId: "call-1",
			extensionPath: "<builtin:comment-checker>",
			statusMessage: "checking\x1b]0;pwned\x07 comments\r\nnext\tpart\x1b[31mred",
			startedAt: Date.now(),
		});

		// Then
		const title = setTitle.mock.calls.at(-1)?.[0];
		expect(title).toBe(`${APP_TITLE} - PostToolUse PreToolUse: checking comments next partred`);
		expect(title).not.toMatch(/[\u0000-\u001f\u007f]/);
		expect(title).not.toContain("owned");
		expect(title).not.toContain("pwned");
	});

	test("shows active tool name in the working row", async () => {
		// Given
		const prototype = InteractiveMode.prototype as unknown as ActiveToolLifecyclePrototype;
		const setTitle = vi.fn();
		const setMessage = vi.fn();
		const toolComponent = {
			markExecutionStarted: vi.fn(),
			updateResult: vi.fn(),
		};
		const fakeThis: ActiveToolLifecycleThis = {
			activeToolExecutionTerminalTitle: undefined,
			activeToolExecutions: new Map(),
			activeToolHooks: new Map(),
			activeToolTerminalTitle: undefined,
			chatContainer: new Container(),
			defaultWorkingMessage: "Working",
			extensionTerminalTitle: undefined,
			footer: { invalidate: vi.fn() },
			getNormalTerminalTitle: prototype.getNormalTerminalTitle,
			getRegisteredToolDefinition: () => undefined,
			getWorkingLoaderMessage: prototype.getWorkingLoaderMessage,
			handleToolExecutionEnd: prototype.handleToolExecutionEnd,
			handleToolExecutionStart: prototype.handleToolExecutionStart,
			hookStatusContainer: new Container(),
			isInitialized: true,
			loadingAnimation: { setMessage },
			pendingTools: new Map([["call-1", toolComponent]]),
			refreshToolHookStatuses: prototype.refreshToolHookStatuses,
			refreshWorkingLoaderMessage: prototype.refreshWorkingLoaderMessage,
			requestStreamingRender: vi.fn(),
			session: { isStreaming: true },
			sessionManager: {
				getCwd: () => "/tmp/senpi-project",
				getSessionName: () => "Visible Session",
			},
			settingsManager: {
				getImageWidthCells: () => 80,
				getShowImages: () => false,
			},
			startToolHookStatusTimer: vi.fn(),
			stopToolHookStatusTimer: vi.fn(),
			toolOutputExpanded: false,
			workingMessage: "Thinking",
			workingMessageBeforeActiveTool: undefined,
			applyTerminalTitle: prototype.applyTerminalTitle,
			updateTerminalTitle: prototype.updateTerminalTitle,
			ui: {
				requestRender: vi.fn(),
				terminal: { setTitle },
			},
		};

		const startEvent = {
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "npm run check -- --watch" },
		} satisfies ToolExecutionStartEvent;
		const endEvent = {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		} satisfies ToolExecutionEndEvent;

		// When
		await prototype.handleEvent.call(fakeThis, startEvent);

		// Then
		expect(fakeThis.workingMessage).toBe("Running bash: npm run check -- --watch");
		expect(setMessage).toHaveBeenLastCalledWith("Running bash: npm run check -- --watch");
		expect(setTitle).toHaveBeenLastCalledWith(`${APP_TITLE} - Running bash: npm run check -- --watch`);

		// When
		await prototype.handleEvent.call(fakeThis, endEvent);

		// Then
		expect(fakeThis.workingMessage).toBe("Thinking");
		expect(setMessage).toHaveBeenLastCalledWith("Thinking");
		expect(setTitle).toHaveBeenLastCalledWith(`${APP_TITLE} - Visible Session - senpi-project`);
	});
});

describe("InteractiveMode.setToolsExpanded", () => {
	test("applies expansion state to the active header and chat entries", () => {
		const header = { setExpanded: vi.fn() };
		const chatChild = { setExpanded: vi.fn() };
		const fakeThis: any = {
			toolOutputExpanded: false,
			customHeader: undefined,
			builtInHeader: header,
			chatContainer: { children: [chatChild] },
			ui: { requestRender: vi.fn() },
		};

		(InteractiveMode as any).prototype.setToolsExpanded.call(fakeThis, true);

		expect(fakeThis.toolOutputExpanded).toBe(true);
		expect(header.setExpanded).toHaveBeenCalledWith(true);
		expect(chatChild.setExpanded).toHaveBeenCalledWith(true);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode.createExtensionUIContext setTheme", () => {
	test("persists theme changes to settings manager", () => {
		initTheme("dark");

		let currentTheme = "dark";
		const settingsManager = {
			getTheme: vi.fn(() => currentTheme),
			setTheme: vi.fn((theme: string) => {
				currentTheme = theme;
			}),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("light");

		expect(result.success).toBe(true);
		expect(settingsManager.setTheme).toHaveBeenCalledWith("light");
		expect(currentTheme).toBe("light");
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("does not persist invalid theme names", () => {
		initTheme("dark");

		const settingsManager = {
			getTheme: vi.fn(() => "dark"),
			setTheme: vi.fn(),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("__missing_theme__");

		expect(result.success).toBe(false);
		expect(settingsManager.setTheme).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode.showExtensionCustom", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("overlay custom UI reclaims input after non-overlay custom UI closes", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const ui = new TUI(terminal);
		const editorContainer = new Container();
		const editor = new TestFocusableComponent("EDITOR");
		const palette = new TestFocusableComponent("PALETTE");
		const overlay = new TestFocusableComponent("OVERLAY");
		const replacement = new TestFocusableComponent("REPLACEMENT");
		let closeOverlay: (value: string) => void = () => {
			throw new Error("closeOverlay was not initialized");
		};
		let closeReplacement: (value: string) => void = () => {
			throw new Error("closeReplacement was not initialized");
		};
		const fakeThis = {
			editor,
			editorContainer,
			keybindings: {},
			ui,
		};
		const showExtensionCustom = <T>(
			factory: (tui: TUI, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component,
			options?: { overlay?: boolean },
		): Promise<T> =>
			(InteractiveMode as any).prototype.showExtensionCustom.call(fakeThis, factory, options) as Promise<T>;

		editorContainer.addChild(editor);
		ui.addChild(editorContainer);
		ui.addChild(palette);
		ui.setFocus(palette);
		ui.start();
		try {
			const overlayPromise = showExtensionCustom<string>(
				(_tui, _theme, _keybindings, done) => {
					closeOverlay = done;
					return overlay;
				},
				{ overlay: true },
			);
			await flushTui(ui, terminal);
			expect(overlay.focused).toBe(true);

			const replacementPromise = showExtensionCustom<string>((_tui, _theme, _keybindings, done) => {
				closeReplacement = done;
				return replacement;
			});
			await flushTui(ui, terminal);
			expect(replacement.focused).toBe(true);

			closeReplacement("done");
			await replacementPromise;
			await flushTui(ui, terminal);
			terminal.sendInput("x");
			await flushTui(ui, terminal);

			expect(overlay.inputs).toEqual(["x"]);
			expect(editor.inputs).toEqual([]);
			expect(overlay.focused).toBe(true);

			closeOverlay("closed");
			await overlayPromise;
		} finally {
			ui.stop();
		}
	});
});

describe("InteractiveMode.createExtensionUIContext addAutocompleteProvider", () => {
	test("stores wrapper factories and rebuilds autocomplete immediately", () => {
		const wrapper: AutocompleteProviderFactory = (current) => current;
		const fakeThis = {
			autocompleteProviderWrappers: [] as AutocompleteProviderFactory[],
			setupAutocompleteProvider: vi.fn(),
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		uiContext.addAutocompleteProvider(wrapper);

		expect(fakeThis.autocompleteProviderWrappers).toEqual([wrapper]);
		expect(fakeThis.setupAutocompleteProvider).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode.setupAutocompleteProvider", () => {
	test("stacks wrapper factories over a fresh base provider", () => {
		const defaultEditor = { setAutocompleteProvider: vi.fn() };
		const customEditor = { setAutocompleteProvider: vi.fn() };
		const calls: string[] = [];

		const wrap1: AutocompleteProviderFactory = (current): AutocompleteProvider => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				calls.push("getSuggestions:wrap1");
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				calls.push("applyCompletion:wrap1");
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				calls.push("shouldTrigger:wrap1");
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		});
		const wrap2: AutocompleteProviderFactory = (current): AutocompleteProvider => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				calls.push("getSuggestions:wrap2");
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				calls.push("applyCompletion:wrap2");
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				calls.push("shouldTrigger:wrap2");
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		});

		const fakeThis = {
			createBaseAutocompleteProvider: () => new CombinedAutocompleteProvider([], "/tmp/project", undefined),
			defaultEditor,
			editor: customEditor,
			autocompleteProviderWrappers: [wrap1, wrap2],
		};

		(InteractiveMode as any).prototype.setupAutocompleteProvider.call(fakeThis);

		expect(defaultEditor.setAutocompleteProvider).toHaveBeenCalledTimes(1);
		expect(customEditor.setAutocompleteProvider).toHaveBeenCalledTimes(1);
		const provider = defaultEditor.setAutocompleteProvider.mock.calls[0]?.[0] as AutocompleteProvider;
		expect(provider).toBe(customEditor.setAutocompleteProvider.mock.calls[0]?.[0]);
		expect(provider.shouldTriggerFileCompletion?.(["foo"], 0, 3)).toBe(true);
		expect(calls).toEqual(["shouldTrigger:wrap2", "shouldTrigger:wrap1"]);
	});
});

describe("InteractiveMode.getWorkingIndicatorOptions", () => {
	beforeAll(() => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	test("uses a Codex-style shimmering bullet indicator with animated working text in truecolor", () => {
		// Given
		const fakeThis: any = {
			workingIndicatorOptions: undefined,
			getWorkingElapsedSeconds: () => 7,
		};

		// When
		const options = (InteractiveMode as any).prototype.getWorkingIndicatorOptions.call(fakeThis);
		const messageFormatter = options.messageFormatter;

		// Then
		expect(options.frames).toHaveLength(1);
		expect(stripAnsi(options.frames[0])).toBe("•");
		expect(options.indicatorFormatter).toBeDefined();
		expect(stripAnsi(options.indicatorFormatter?.("•", 0) ?? "")).toBe("•");
		expect(stripAnsi(options.indicatorFormatter?.("•", 1_000) ?? "")).toBe("•");
		expect(options.indicatorFormatter?.("•", 0)).not.toBe(options.indicatorFormatter?.("•", 1_000));
		expect(options.intervalMs).toBe(600);
		expect(options.messageIntervalMs).toBe(32);
		expect(typeof messageFormatter).toBe("function");
		expect(messageFormatter).toBeDefined();

		const firstFrame = messageFormatter("Working", 0);
		const nextFrame = messageFormatter("Working", 1_000);

		expect(stripAnsi(firstFrame)).toBe("Working (7s • esc to interrupt)");
		expect(stripAnsi(nextFrame)).toBe("Working (7s • esc to interrupt)");
		expect(firstFrame).not.toBe(nextFrame);
	});

	test("falls back to Codex's 600ms bullet blink outside truecolor", () => {
		// Given
		resetCapabilitiesCache();
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		initTheme("dark");
		const fakeThis: any = {
			workingIndicatorOptions: undefined,
			getWorkingElapsedSeconds: () => 7,
		};

		// When
		const options = (InteractiveMode as any).prototype.getWorkingIndicatorOptions.call(fakeThis);

		// Then
		expect(options.frames).toHaveLength(2);
		expect(stripAnsi(options.frames[0])).toBe("•");
		expect(stripAnsi(options.frames[1])).toBe("◦");
		expect(options.intervalMs).toBe(600);
	});
});

describe("InteractiveMode.showLoadedResources", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	function createShowLoadedResourcesThis(options: {
		quietStartup: boolean;
		verbose?: boolean;
		toolOutputExpanded?: boolean;
		cwd?: string;
		contextFiles?: Array<{ path: string; content?: string }>;
		extensions?: ExtensionFixture[];
		skills?: Array<{ filePath: string; name: string }>;
		skillDiagnostics?: Array<{ type: "warning" | "error" | "collision"; message: string }>;
		useRealScopeGroups?: boolean;
	}) {
		const fakeThis: any = {
			options: { verbose: options.verbose ?? false },
			toolOutputExpanded: options.toolOutputExpanded ?? false,
			chatContainer: new Container(),
			settingsManager: {
				getQuietStartup: () => options.quietStartup,
				getDisabledBuiltinExtensions: () => [],
			},
			sessionManager: {
				getCwd: () => options.cwd ?? "/tmp/project",
			},
			session: {
				promptTemplates: [],
				extensionRunner: {
					getCommandDiagnostics: () => [],
					getShortcutDiagnostics: () => [],
				},
				resourceLoader: {
					getPathMetadata: () => new Map(),
					getAgentsFiles: () => ({ agentsFiles: options.contextFiles ?? [] }),
					getSkills: () => ({
						skills: options.skills ?? [],
						diagnostics: options.skillDiagnostics ?? [],
					}),
					getPrompts: () => ({ prompts: [], diagnostics: [] }),
					getExtensions: () => ({ extensions: options.extensions ?? [], errors: [], runtime: {} }),
					getThemes: () => ({ themes: [], diagnostics: [] }),
				},
			},
			formatDisplayPath: (p: string) => (InteractiveMode as any).prototype.formatDisplayPath.call(fakeThis, p),
			formatExtensionDisplayPath: (p: string) =>
				(InteractiveMode as any).prototype.formatExtensionDisplayPath.call(fakeThis, p),
			formatContextPath: (p: string) => (InteractiveMode as any).prototype.formatContextPath.call(fakeThis, p),
			getStartupExpansionState: () => (InteractiveMode as any).prototype.getStartupExpansionState.call(fakeThis),
			getBuiltinExtensionNameFromPath: (InteractiveMode as any).prototype.getBuiltinExtensionNameFromPath,
			getBuiltinExtensionDisplayName: (InteractiveMode as any).prototype.getBuiltinExtensionDisplayName,
			formatExtensionScopeGroups: (extensions: unknown[]) =>
				(InteractiveMode as any).prototype.formatExtensionScopeGroups.call(fakeThis, extensions),
			buildScopeGroups: () => [],
			formatScopeGroups: () => "resource-list",
			isPackageSource: (sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.isPackageSource.call(fakeThis, sourceInfo),
			getShortPath: (p: string, sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getShortPath.call(fakeThis, p, sourceInfo),
			getCompactPathLabel: (p: string, sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getCompactPathLabel.call(fakeThis, p, sourceInfo),
			getCompactPackageSourceLabel: (sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getCompactPackageSourceLabel.call(fakeThis, sourceInfo),
			getCompactExtensionLabel: (p: string, sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getCompactExtensionLabel.call(fakeThis, p, sourceInfo),
			getCompactDisplayPathSegments: (p: string) =>
				(InteractiveMode as any).prototype.getCompactDisplayPathSegments.call(fakeThis, p),
			getCompactNonPackageExtensionLabel: (
				p: string,
				index: number,
				allPaths: Array<{ path: string; segments: string[] }>,
			) => (InteractiveMode as any).prototype.getCompactNonPackageExtensionLabel.call(fakeThis, p, index, allPaths),
			getCompactExtensionLabels: (extensions: ExtensionFixture[]) =>
				(InteractiveMode as any).prototype.getCompactExtensionLabels.call(fakeThis, extensions),
			formatDiagnostics: () => "diagnostics",
			getBuiltInCommandConflictDiagnostics: () => [],
		};

		if (options.useRealScopeGroups) {
			fakeThis.getScopeGroup = (sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getScopeGroup.call(fakeThis, sourceInfo);
			fakeThis.buildScopeGroups = (items: Array<{ path: string; sourceInfo?: SourceInfo }>) =>
				(InteractiveMode as any).prototype.buildScopeGroups.call(fakeThis, items);
			fakeThis.formatScopeGroups = (groups: unknown, formatOptions: unknown) =>
				(InteractiveMode as any).prototype.formatScopeGroups.call(fakeThis, groups, formatOptions);
		}

		return fakeThis;
	}

	function createSourceInfo(
		filePath: string,
		options: {
			source: string;
			scope: "user" | "project" | "temporary";
			origin: "package" | "top-level";
			baseDir?: string;
		},
	): SourceInfo {
		return {
			path: filePath,
			source: options.source,
			scope: options.scope,
			origin: options.origin,
			baseDir: options.baseDir,
		};
	}

	function createExtensionFixtures(): ExtensionFixture[] {
		return [
			{
				path: "/tmp/project/.pi/extensions/answer.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/extensions/answer.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/project/.pi/extensions",
				}),
			},
			{
				path: "/tmp/project/.pi/extensions/local-index/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/extensions/local-index/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/project/.pi/extensions",
				}),
			},
			{
				path: "/tmp/agent/extensions/user-index/index.ts",
				sourceInfo: createSourceInfo("/tmp/agent/extensions/user-index/index.ts", {
					source: "local",
					scope: "user",
					origin: "top-level",
					baseDir: "/tmp/agent/extensions",
				}),
			},
			{
				path: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts", {
					source: "npm:pi-markdown-preview",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview",
				}),
			},
			{
				path: "/tmp/project/.pi/npm/node_modules/@scope/pi-scoped/extensions/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/npm/node_modules/@scope/pi-scoped/extensions/index.ts", {
					source: "npm:@scope/pi-scoped",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.pi/npm/node_modules/@scope/pi-scoped",
				}),
			},
			{
				path: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-tools/extensions/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.pi/git/github.com/HazAT/pi-interactive-tools/extensions/index.ts",
					{
						source: "git:github.com/HazAT/pi-interactive-tools",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-tools",
					},
				),
			},
			{
				path: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-tools/extensions/workflows/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.pi/git/github.com/HazAT/pi-interactive-tools/extensions/workflows/index.ts",
					{
						source: "git:github.com/HazAT/pi-interactive-tools",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-tools",
					},
				),
			},
			{
				path: "/tmp/temp/cli-extension.ts",
				sourceInfo: createSourceInfo("/tmp/temp/cli-extension.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/temp",
				}),
			},
		];
	}

	test("shows a compact resource listing by default", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Skills]");
		expect(output).toContain("commit");
		expect(output).not.toContain("resource-list");
	});

	test("shows full resource listing when expanded", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Skills]");
		expect(output).toContain("resource-list");
		expect(output).not.toContain("commit");
	});

	test("shows full resource listing on verbose startup even when tool output is collapsed", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			verbose: true,
			toolOutputExpanded: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Skills]");
		expect(output).toContain("resource-list");
		expect(output).not.toContain("commit");
	});

	test("abbreviates extensions in compact listing", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions: [{ path: "/tmp/extensions/answer.ts" }, { path: "/tmp/extensions/btw.ts" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Extensions]");
		expect(output).toContain("answer.ts, btw.ts");
		expect(output).not.toContain("extensions/answer.ts");
	});

	test("captures mixed extension layouts in compact output", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions: createExtensionFixtures(),
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  @scope/pi-scoped, answer.ts, cli-extension.ts, HazAT/pi-interactive-tools, HazAT/pi-interactive-tools:workflows, local-index, pi-markdown-preview, user-index"`);
	});

	test("adds more parent folders until local extension labels are unique", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/alpha/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/alpha/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/alpha",
				}),
			},
			{
				path: "/tmp/beta/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/beta/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/beta",
				}),
			},
			{
				path: "/tmp/gamma/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/gamma/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/gamma",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  alpha/one, beta/one, gamma/one"`);
	});

	test("strips index.ts from local extension label, showing parent dir", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/plan-mode/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  plan-mode"`);
	});

	test("strips index.js from local extension label, showing parent dir", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/plan-mode/index.js",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.js", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  plan-mode"`);
	});

	test("mixed single-file and subdirectory index.ts extensions strip index.ts", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/single-file-extension.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/single-file-extension.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
			{
				path: "/tmp/extensions/plan-mode/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  plan-mode, single-file-extension.ts"`);
	});

	test("multiple index.ts with unique parent dirs need no disambiguation", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/foo/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/foo/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
			{
				path: "/tmp/extensions/bar/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/bar/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  bar, foo"`);
	});

	test("multiple index.ts with same parent dir name disambiguated with grandparent", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/alpha/tools/index.ts",
				sourceInfo: createSourceInfo("/tmp/alpha/tools/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/alpha",
				}),
			},
			{
				path: "/tmp/beta/tools/index.ts",
				sourceInfo: createSourceInfo("/tmp/beta/tools/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/beta",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  alpha/tools, beta/tools"`);
	});

	test("non-index file in subdirectory stays as filename", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/my-ext/main.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/my-ext/main.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  main.ts"`);
	});

	test("package extensions still strip index.ts correctly (regression guard)", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts", {
					source: "npm:pi-markdown-preview",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  pi-markdown-preview"`);
	});
	test("captures mixed extension layouts in expanded output", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			extensions: createExtensionFixtures(),
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  project
    /tmp/project/.pi/extensions/answer.ts
    /tmp/project/.pi/extensions/local-index
    git:github.com/HazAT/pi-interactive-tools
      extensions
      extensions/workflows
    npm:@scope/pi-scoped
      extensions
    npm:pi-markdown-preview
      extensions
  user
    /tmp/agent/extensions/user-index
  path
    /tmp/temp/cli-extension.ts"`);
	});

	test("shows context paths relative to cwd while preserving full external paths", () => {
		const home = homedir();
		const cwd = path.join(home, "Development", "pi-mono");
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			cwd,
			contextFiles: [{ path: path.join(home, ".pi", "agent", "AGENTS.md") }, { path: path.join(cwd, "AGENTS.md") }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.chatContainer).replace(/\\/g, "/");
		expect(output).toContain("[Context]");
		expect(output).toContain("~/.pi/agent/AGENTS.md, AGENTS.md");
		expect(output).not.toContain(`${cwd.replace(/\\/g, "/")}/AGENTS.md`);
	});

	test("shows full context paths when expanded", () => {
		const home = homedir();
		const cwd = path.join(home, "Development", "pi-mono");
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			cwd,
			contextFiles: [{ path: path.join(home, ".pi", "agent", "AGENTS.md") }, { path: path.join(cwd, "AGENTS.md") }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.chatContainer).replace(/\\/g, "/");
		expect(output).toContain("[Context]");
		expect(output).toContain("~/.pi/agent/AGENTS.md");
		expect(output).toContain("~/Development/pi-mono/AGENTS.md");
		expect(output).not.toContain("~/.pi/agent/AGENTS.md, AGENTS.md");
	});

	test("does not show verbose listing on quiet startup during reload", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			extensions: [{ path: "/tmp/ext/index.ts" }],
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		expect(fakeThis.chatContainer.children).toHaveLength(0);
	});

	test("still shows diagnostics on quiet startup when requested", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
			skillDiagnostics: [{ type: "warning", message: "duplicate skill name" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Skill conflicts]");
		expect(output).not.toContain("[Skills]");
	});

	test("formats builtin synthetic extension paths with readable builtin labels", () => {
		// given
		const path = "<builtin:todowrite>";
		const fakeThis = {
			getBuiltinExtensionNameFromPath: (InteractiveMode as any).prototype.getBuiltinExtensionNameFromPath,
			getBuiltinExtensionDisplayName: (InteractiveMode as any).prototype.getBuiltinExtensionDisplayName,
		};

		// when
		const displayPath = (InteractiveMode as any).prototype.formatDisplayPath.call(fakeThis, path);

		// then
		expect(displayPath).toBe("builtin/todo");
	});

	test("groups builtin extensions separately from user extensions", () => {
		const home = os.homedir();
		const fakeThis: any = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
		});
		fakeThis.getBuiltinExtensionDisplayName = (InteractiveMode as any).prototype.getBuiltinExtensionDisplayName;
		fakeThis.getBuiltinExtensionNameFromPath = (InteractiveMode as any).prototype.getBuiltinExtensionNameFromPath;
		fakeThis.formatDisplayPath = (InteractiveMode as any).prototype.formatDisplayPath;
		fakeThis.getShortPath = (InteractiveMode as any).prototype.getShortPath;
		fakeThis.getScopeGroup = (InteractiveMode as any).prototype.getScopeGroup;
		fakeThis.isPackageSource = (InteractiveMode as any).prototype.isPackageSource;
		fakeThis.buildScopeGroups = (InteractiveMode as any).prototype.buildScopeGroups;
		fakeThis.formatScopeGroups = (InteractiveMode as any).prototype.formatScopeGroups;
		fakeThis.formatExtensionScopeGroups = (InteractiveMode as any).prototype.formatExtensionScopeGroups;

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			extensions: [
				{ path: "<builtin:todowrite>" },
				{ path: "<builtin:redraws>" },
				{
					path: `${home}/.senpi/agent/extensions/diff.js`,
					sourceInfo: {
						path: `${home}/.senpi/agent/extensions/diff.js`,
						source: "local",
						scope: "user",
						origin: "top-level",
						baseDir: `${home}/.senpi/agent/extensions`,
					},
				},
			],
			force: true,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Extensions]");
		expect(output).toContain("builtin");
		expect(output).toContain("redraws");
		expect(output).toContain("todo");
		expect(output).toContain("user");
		expect(output).toContain("~/.senpi/agent/extensions/diff.js");
		expect(output).not.toContain("todowrite");
	});
});
