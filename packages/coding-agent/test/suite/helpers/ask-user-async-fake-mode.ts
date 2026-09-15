/**
 * Minimal `InteractiveMode` stand-in for the async ask-user tests: real
 * prototype methods run against a hand-built field set (editor container,
 * widget map, session spies) so the widget/overlay/submit path is exercised
 * without a terminal.
 */

import { Container, Text, type TUI } from "@earendil-works/pi-tui";
import { type Mock, vi } from "vitest";
import type { ExtensionUIContext, ExtensionWidgetOptions } from "../../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { type Theme, theme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

type WidgetComponent = { render(width: number): string[]; dispose?(): void };
type WidgetContent = string[] | ((tui: TUI | undefined, thm: Theme) => WidgetComponent) | undefined;

export type FakeEditor = Text & {
	getText(): string;
	isShowingAutocomplete(): boolean;
	setText: Mock<(text: string) => void>;
	addToHistory: Mock<(text: string) => void>;
};

export type FakeSession = {
	isStreaming: boolean;
	isCompacting: boolean;
	messages: unknown[];
	settingsManager: SettingsManager;
	emitExtensionEvent: Mock<(channel: string, data: unknown) => void>;
	sendUserMessage: Mock<(text: string, options?: { deliverAs?: "steer" | "followUp" }) => Promise<void>>;
	prompt: Mock<(text: string, options?: object) => Promise<void>>;
};

export type FakeInteractiveMode = {
	editorContainer: Container;
	editor: FakeEditor;
	defaultEditor: FakeEditor & { onSubmit?: (text: string) => Promise<void> | void };
	ui: {
		setFocus: Mock<(component: unknown) => void>;
		getFocusedComponent(): unknown;
		hasOverlay(): boolean;
		requestRender: Mock<() => void>;
	};
	/** Read through the prototype's `session` getter from `runtimeHost.session`. */
	readonly session: FakeSession;
	runtimeHost: { session: FakeSession; sendHostUiProgress?: Mock<(record: unknown) => void> };
	onInputCallback: Mock<(input: unknown) => void>;
	handleDebugCommand: Mock<() => void>;
	showStatus: Mock<(message: string) => void>;
	createExtensionUIContext(): ExtensionUIContext;
	handleAskUserShortcut(data: string): boolean;
	setupEditorSubmitHandler(): void;
	/** Rendered text of the widget stored under `key`, or undefined when cleared. */
	widgetText(key: string): string | undefined;
	pressEditorKey(data: string): boolean;
	submitEditorText(text: string): Promise<void>;
};

export function createFakeInteractiveMode(options: { isStreaming?: boolean } = {}): FakeInteractiveMode {
	const widgets = new Map<string, WidgetComponent>();
	const editorContainer = new Container();
	let text = "";
	const editor: FakeEditor = Object.assign(new Text("", 0, 0), {
		getText: () => text,
		isShowingAutocomplete: () => false,
		setText: vi.fn((value: string) => {
			text = value;
		}),
		addToHistory: vi.fn(),
		setReplyLabel: vi.fn(),
	});
	let focused: unknown = editor;
	editorContainer.addChild(editor);
	const session: FakeSession = {
		isStreaming: options.isStreaming ?? false,
		isCompacting: false,
		messages: [],
		settingsManager: SettingsManager.inMemory(),
		emitExtensionEvent: vi.fn(),
		sendUserMessage: vi.fn(async () => {}),
		prompt: vi.fn(async () => {}),
	};
	const fields = {
		editorContainer,
		editor,
		defaultEditor: editor,
		ui: {
			terminal: { write: vi.fn(), setTitle: vi.fn(), rows: 36, columns: 120 },
			setFocus: vi.fn((component: unknown) => {
				focused = component;
			}),
			getFocusedComponent: () => focused,
			hasOverlay: () => false,
			requestRender: vi.fn(),
			renderNow: vi.fn(),
			acquireMouseCapture: vi.fn(() => vi.fn()),
		},
		keybindings: new KeybindingsManager(),
		getNormalTerminalTitle: () => "senpi",
		questionArrivalEpochMs: Date.now(),
		runtimeHost: { session },
		onInputCallback: vi.fn(),
		handleDebugCommand: vi.fn(),
		showStatus: vi.fn(),
		askUserQuestion: undefined,
		pendingQuestions: new Map<string, unknown>(),
		pendingOrder: [],
		shownQuestionId: undefined,
		questionSurface: "collapsed",
		composerDestination: { kind: "chat" },
		lastEditorText: "",
		preResolvedSubmissionImages: undefined,
		pendingUserInputs: [],
		workingMessage: undefined,
		optimisticUserEchoes: { begin: () => "echo", promptOptions: () => ({}), reject: vi.fn() },
		hideShortcutOverlay: vi.fn(),
		updateWorkingIndicatorMessage: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		disposeActiveSelector: vi.fn(),
		isExtensionCommand: () => false,
		takeSubmissionImages: () => [],
		showError: (message: string) => {
			throw new Error(message);
		},
		setExtensionWidget: (key: string, content: WidgetContent, _options?: ExtensionWidgetOptions) => {
			widgets.get(key)?.dispose?.();
			widgets.delete(key);
			if (content === undefined) return;
			if (Array.isArray(content)) {
				const container = new Container();
				for (const line of content) container.addChild(new Text(line, 0, 0));
				widgets.set(key, container);
				return;
			}
			widgets.set(key, content(undefined, theme));
		},
		widgetText: (key: string) => {
			const widget = widgets.get(key);
			return widget ? stripAnsi(widget.render(120).join("\n")) : undefined;
		},
		pressEditorKey: (data: string): boolean => fake.handleAskUserShortcut(data),
		submitEditorText: async (text: string) => {
			if (!fake.defaultEditor.onSubmit) fake.setupEditorSubmitHandler();
			// This helper models typing followed by Enter, including the host's pre-insertion destination binding.
			if (text !== "" && !text.startsWith("/") && !text.startsWith("!") && fake.editor.getText() === "") {
				fake.handleAskUserShortcut(text);
			}
			await fake.defaultEditor.onSubmit?.(text);
		},
	};
	const fake: FakeInteractiveMode = Object.assign(Object.create(InteractiveMode.prototype), fields);
	return fake;
}
